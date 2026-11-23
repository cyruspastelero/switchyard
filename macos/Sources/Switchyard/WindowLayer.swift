import AppKit
import ApplicationServices

struct ManagedWindow {
    let id: ElementID
    let key: String
    let pid: pid_t
    let app: String
    let bundleId: String
    let title: String
    let document: String?
    let frame: Rect
    let browser: BrowserBlock?
    let windowNumber: UInt32?
    /// Desktop number, counted across displays as Ctrl+N does; nil when fullscreen, minimized or on all desktops.
    let desktop: Int?
    /// Native tab titles of a terminal window with two or more tabs.
    var tabTitles: [String] = []

    var snapshot: WindowSnapshot {
        WindowSnapshot(key: key, app: app, bundleId: bundleId, pid: pid, title: title, document: document, browser: browser,
                       desktop: desktop, tabTitles: tabTitles.isEmpty ? nil : tabTitles)
    }
}

private struct RawWindow: @unchecked Sendable {
    let id: ElementID
    let pid: pid_t
    let app: String
    let bundleId: String
    let title: String
    let document: String?
    let frame: Rect
    let windowNumber: UInt32?
    let minimized: Bool
    var tabTitles: [String] = []

    /// The same window with title, frame and tabs read again from its element (it may sit on another desktop).
    func reread() -> RawWindow {
        RawWindow(id: id, pid: pid, app: app, bundleId: bundleId,
                  title: AX.string(id.element, kAXTitleAttribute as String) ?? title, document: document,
                  frame: AX.frame(id.element) ?? frame, windowNumber: windowNumber, minimized: minimized,
                  tabTitles: TerminalTabs.reads(bundleId: bundleId) ? TerminalTabs.titles(of: id.element) : [])
    }
}

private struct AppInfo: Sendable {
    let pid: pid_t
    let name: String
    let bundleId: String
}

/// What one `show` cost, for the switch timing log.
struct ShowTiming {
    var desktopMs = 0.0
    var restoreMs = 0.0
    var raiseMs = 0.0
    var hideMs = 0.0
    var shown = 0
    var raised = 0
    var hidden = 0
    var restored = 0
}

/// Owns everything that touches other apps' windows: enumeration, hiding off-screen, restoring, raising.
actor WindowLayer {
    private let browsers = BrowserCache()
    private var slowApps = SlowApps()
    /// Last answer of each app, reused while the app is being skipped for answering slowly.
    private var lastRaws: [pid_t: [RawWindow]] = [:]
    private var recovered = false
    private let store: HiddenStore
    private var keys: [ElementID: String] = [:]
    private var hidden: [ElementID: HiddenRecord] = [:]
    private(set) var latest: [ManagedWindow] = []
    /// Windows seen before, by window number. `kAXWindows` leaves out windows on other desktops; these fill the gap.
    private var seen: [UInt32: RawWindow] = [:]
    /// The main display's desktops at the last refresh; nil when they can't be read.
    private(set) var desktops: DesktopsInfo?
    /// False once every carry of a sort failed; the server then hides windows off-screen instead.
    private(set) var canCarry = true

    func setCanCarry(_ value: Bool) { canCarry = value }

    init(store: HiddenStore = HiddenStore()) { self.store = store }

    // MARK: Enumeration

    /// Fresh view of every window plus its browser block. Does nothing without the Accessibility grant.
    func refresh() async -> [ManagedWindow] {
        guard AX.isTrusted(prompt: false) else { latest = []; return [] }
        // Once, as soon as the grant is there (it can arrive long after launch): bring back what a previous run left hidden.
        if !recovered { recovered = true; await recoverStranded() }
        let apps = await regularApps()
        let running = apps.compactMap { app in BrowserKind(rawValue: app.bundleId).map { BrowserInstance(kind: $0, pid: app.pid) } }
        let browserWindows = await browsers.current(running: running) // cached: never waits on a browser
        // Asking every app is the slow part (a hung app costs a full timeout), so it runs off this actor:
        // a switch never waits behind it.
        let now = Date()
        let asked = apps.filter { !slowApps.shouldSkip($0.pid, now: now) }
        let scan = await Task.detached(priority: .userInitiated) { WindowLayer.scan(asked) }.value
        await findOnOtherDesktops(apps: apps, listed: scan.raws.values.flatMap { $0 })
        // No await below this line, so two refreshes cannot interleave their bookkeeping.
        for app in asked {
            let seconds = scan.seconds[app.pid] ?? 0
            if let wait = slowApps.record(pid: app.pid, seconds: seconds, now: Date()) {
                Log.windows.notice("\(app.bundleId, privacy: .public) took \(Int(seconds * 1000), privacy: .public) ms to list its windows; not asking it for \(Int(wait), privacy: .public) s")
            } else {
                lastRaws[app.pid] = scan.raws[app.pid] ?? []
            }
        }
        let livePids = Set(apps.map(\.pid))
        slowApps.keep(only: livePids)
        lastRaws = lastRaws.filter { livePids.contains($0.key) }
        let raws = withOtherDesktops(apps.flatMap { lastRaws[$0.pid] ?? [] }, livePids: livePids)
        let browserByWindow = matchBrowsers(raws: raws, browserWindows: browserWindows)

        var taken = Set<String>()
        var result: [ManagedWindow] = []
        var liveKeys: [ElementID: String] = [:]
        for (i, raw) in raws.enumerated() {
            let b = browserByWindow[i]
            let key = keys[raw.id] ?? WindowKeys.make(bundleId: raw.bundleId, pid: raw.pid, windowNumber: raw.windowNumber,
                                                      title: raw.title, document: raw.document, taken: taken)
            taken.insert(key)
            liveKeys[raw.id] = key
            let block = b.map { BrowserBlock(windowId: $0.id, name: $0.name, tabs: $0.tabs, activeTitle: $0.activeTitle) }
            result.append(ManagedWindow(id: raw.id, key: key, pid: raw.pid, app: raw.app, bundleId: raw.bundleId, title: raw.title,
                                        document: raw.document, frame: raw.frame, browser: block, windowNumber: raw.windowNumber,
                                        desktop: desktop(of: raw), tabTitles: raw.tabTitles))
        }
        keys = liveKeys
        hidden = HiddenRecords.surviving(hidden, listed: Set(liveKeys.keys), runningPids: Set(apps.map(\.pid)))
        latest = result
        return result
    }

    private var desktopList: [Desktop] = []

    /// Adds windows seen earlier that now sit on another desktop, and reads the desktop list for this refresh.
    private func withOtherDesktops(_ listed: [RawWindow], livePids: Set<pid_t>) -> [RawWindow] {
        desktopList = Spaces.desktops()
        let active = Spaces.activeDesktopNumber(in: desktopList)
        desktops = desktopList.isEmpty ? nil : DesktopsInfo(count: DesktopList.usableCount(desktopList), active: active,
                                                                     list: Spaces.entries(desktopList))
        let listedIds = Set(listed.compactMap(\.windowNumber))
        // A slow app's windows stay listed from the cache (no Accessibility call): the server takes an unlisted window as closed.
        let candidates = seen.filter { !listedIds.contains($0.key) && livePids.contains($0.value.pid) }
        var kept: [RawWindow] = []
        var remembered: [RawWindow] = []
        if !candidates.isEmpty {
            let alive = Spaces.aliveWindowIds()
            var desktopOf: [UInt32: Int] = [:]
            for id in candidates.keys { desktopOf[id] = Spaces.desktopNumber(ofWindow: id, in: desktopList) }
            let keep = DesktopMerge.keep(cached: Array(candidates.keys), listed: listedIds, alive: alive, desktopOf: desktopOf, active: active)
            kept = keep.compactMap { id in candidates[id].map { slowApps.isSlow($0.pid) ? $0 : $0.reread() } }
            let keptIds = Set(keep)
            remembered = DesktopMerge.remembered(cached: Array(candidates.keys), alive: alive)
                .filter { !keptIds.contains($0) }.compactMap { candidates[$0] }
        }
        let all = listed + kept
        seen = Dictionary((all + remembered).compactMap { r in r.windowNumber.map { ($0, r) } }, uniquingKeysWith: { first, _ in first })
        return all
    }

    private func desktop(of raw: RawWindow) -> Int? {
        guard !raw.minimized, let number = raw.windowNumber else { return nil }
        return Spaces.desktopNumber(ofWindow: number, in: desktopList)
    }

    /// What the carrier needs for a window. Looks the element up again when the cached one went stale.
    func carryTarget(forKey key: String) -> CarryTarget? {
        guard let w = latest.first(where: { $0.key == key }), let number = w.windowNumber else { return nil }
        if AX.frame(w.id.element) != nil {
            return CarryTarget(key: key, pid: w.pid, bundleId: w.bundleId, element: w.id.element, windowId: number)
        }
        guard let found = CarryWindows.find(windowId: number, bundleId: w.bundleId) else { return nil }
        return CarryTarget(key: key, pid: found.pid, bundleId: w.bundleId, element: found.element, windowId: number)
    }

    func window(forKey key: String) async -> ManagedWindow? {
        if let w = latest.first(where: { $0.key == key }) { return w }
        return await refresh().first { $0.key == key }
    }

    @MainActor
    private static func collectApps() -> [AppInfo] {
        let me = ProcessInfo.processInfo.processIdentifier
        return NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular && !$0.isTerminated && $0.processIdentifier != me }
            .map { AppInfo(pid: $0.processIdentifier, name: $0.localizedName ?? "", bundleId: $0.bundleIdentifier ?? "") }
    }

    private func regularApps() async -> [AppInfo] { await WindowLayer.collectApps() }

    /// Lists the windows of each app and how long each app took to answer. Touches no actor state.
    private static func scan(_ apps: [AppInfo]) -> (raws: [pid_t: [RawWindow]], seconds: [pid_t: TimeInterval]) {
        var raws: [pid_t: [RawWindow]] = [:]
        var seconds: [pid_t: TimeInterval] = [:]
        for app in apps {
            let start = Date()
            raws[app.pid] = enumerate(app)
            seconds[app.pid] = Date().timeIntervalSince(start)
        }
        return (raws, seconds)
    }

    private static func enumerate(_ app: AppInfo) -> [RawWindow] {
        AX.windows(of: AX.appElement(pid: app.pid)).compactMap { raw($0, app) }
    }

    private static func raw(_ w: AXUIElement, _ app: AppInfo) -> RawWindow? {
        guard AX.string(w, kAXRoleAttribute as String) == kAXWindowRole as String,
              AX.string(w, kAXSubroleAttribute as String) == kAXStandardWindowSubrole as String,
              let frame = AX.frame(w) else { return nil }
        return RawWindow(id: ElementID(element: w), pid: app.pid, app: app.name, bundleId: app.bundleId,
                         title: AX.string(w, kAXTitleAttribute as String) ?? "",
                         document: documentPath(AX.string(w, kAXDocumentAttribute as String)), frame: frame,
                         windowNumber: AX.windowNumber(w),
                         minimized: AXBool.read(w, kAXMinimizedAttribute as String) == true,
                         tabTitles: TerminalTabs.reads(bundleId: app.bundleId) ? TerminalTabs.titles(of: w) : [])
    }

    private var remoteRetry = RemoteRetry()

    /// Windows on desktops the owner has not visited since launch: found through the window server and
    /// remote Accessibility elements, then remembered like any window seen before.
    private func findOnOtherDesktops(apps: [AppInfo], listed: [RawWindow]) async {
        let now = Date()
        let cgWindows = RemoteWindows.all()
        let list = Spaces.desktops()
        let known = Set(listed.compactMap(\.windowNumber)).union(seen.keys)
        let livePids = Set(apps.filter { !slowApps.isSlow($0.pid) }.map(\.pid))
        let candidates = cgWindows.filter { $0.layer == 0 && !known.contains($0.number) && livePids.contains($0.pid) && remoteRetry.shouldTry($0.number, now: now) }
        guard !candidates.isEmpty else { return }
        var desktopOf: [UInt32: Int] = [:]
        for w in candidates { desktopOf[w.number] = Spaces.desktopNumber(ofWindow: w.number, in: list) }
        let wanted = RemoteWindows.missing(windows: candidates, desktopOf: desktopOf, known: known, livePids: livePids,
                                           active: Spaces.activeDesktopNumber(in: list))
        guard !wanted.isEmpty else { return }
        let byPid = Dictionary(apps.map { ($0.pid, $0) }, uniquingKeysWith: { a, _ in a })
        let found = await Task.detached(priority: .utility) { () -> [RawWindow] in
            wanted.flatMap { pid, numbers -> [RawWindow] in
                guard let app = byPid[pid] else { return [] }
                return RemoteWindows.elements(pid: pid, wanted: Set(numbers)).values.compactMap { WindowLayer.raw($0, app) }
            }
        }.value
        for r in found { if let n = r.windowNumber, seen[n] == nil { seen[n] = r } }
        let foundIds = Set(found.compactMap(\.windowNumber))
        remoteRetry.failed(wanted.values.flatMap { $0 }.filter { !foundIds.contains($0) }, at: now)
        remoteRetry.keep(only: Set(cgWindows.map(\.number)))
        let missed = wanted.values.map(\.count).reduce(0, +) - found.count
        Log.windows.notice("other desktops: found \(found.count, privacy: .public) windows by remote element, \(missed, privacy: .public) without one")
    }

    /// AXDocument is usually a file URL; the server wants a path.
    static func documentPath(_ raw: String?) -> String? {
        guard let raw, !raw.isEmpty else { return nil }
        if let u = URL(string: raw), u.isFileURL { return u.path }
        return raw
    }

    private func matchBrowsers(raws: [RawWindow], browserWindows: [BrowserWindow]) -> [Int: BrowserWindow] {
        let candidates = raws.enumerated().map {
            BrowserCandidate(index: $0.offset, bundleId: $0.element.bundleId, pid: $0.element.pid, title: $0.element.title, frame: $0.element.frame)
        }
        return BrowserInstances.pair(candidates: candidates, browser: browserWindows)
    }

    /// pid -> window count of each process of `kind` that answered its last listing.
    func answeringBrowsers(_ kind: BrowserKind) async -> [pid_t: Int] { await browsers.answering(kind) }

    // MARK: Virtual desktops

    /// Brings the shown windows back and raises `raise` (front first), then hides the listed windows behind
    /// them, then brings back whatever else is no longer hidden. Works from the last refresh: it asks no app
    /// for its window list, so the target is in front after a handful of Accessibility calls.
    /// `desktop`: the switch's target desktop. A window not on the active desktop is never raised (no bounce).
    @discardableResult
    func show(_ sets: ShowSets, raise raiseKeys: [String], desktop: Int? = nil) async -> ShowTiming {
        if latest.isEmpty { _ = await refresh() } // just launched: nothing cached yet
        let screens = await MainActor.run { currentScreenFrames() }
        let wins = latest
        let byKey = Dictionary(wins.map { ($0.key, $0) }, uniquingKeysWith: { first, _ in first })
        let hiddenKeys = Set(wins.filter { hidden[$0.id] != nil }.map(\.key))
        let phases = ShowPlan.phases(keys: wins.map(\.key), hidden: hiddenKeys, sets: sets)
        var timing = ShowTiming(shown: sets.shown.count)

        var mark = Date()
        for key in phases.restoreFirst { if let w = byKey[key] { unhide(w, screens: screens) } }
        // Hidden windows that are not listed right now (another macOS desktop) come back too when they should show.
        let listed = Set(wins.map(\.id))
        let unlisted = hidden.filter { !listed.contains($0.key) && !ShowPlan.hides($0.value.key, sets) }
        for (id, rec) in unlisted where sets.shown.contains(rec.key) { restore(id, rec, screens: screens) }
        timing.restoreMs = Self.msSince(&mark)

        let targets = onActiveDesktop(raiseKeys.compactMap { byKey[$0] }, target: desktop)
        await raise(targets)
        timing.raised = targets.count
        timing.raiseMs = Self.msSince(&mark)

        for key in phases.hide { if let w = byKey[key] { hide(w, screens: screens) } }
        timing.hidden = phases.hide.count
        timing.hideMs = Self.msSince(&mark)

        for key in phases.restoreLast { if let w = byKey[key] { unhide(w, screens: screens) } }
        for (id, rec) in unlisted where !sets.shown.contains(rec.key) { restore(id, rec, screens: screens) }
        timing.restored = phases.restoreFirst.count + phases.restoreLast.count + unlisted.count
        persist()
        return timing
    }

    private static func msSince(_ mark: inout Date) -> Double {
        let now = Date()
        defer { mark = now }
        return now.timeIntervalSince(mark) * 1000
    }

    func restoreAll() async {
        let screens = await MainActor.run { currentScreenFrames() }
        for (id, rec) in hidden { restore(id, rec, screens: screens) }
        hidden.removeAll()
        persist()
    }

    /// Bring back windows a previous run left off-screen. Windows this run has hidden are left alone.
    private func recoverStranded() async {
        let screens = await MainActor.run { currentScreenFrames() }
        let records = store.load()
        let apps = await regularApps()
        let raws = WindowLayer.scan(apps).raws.values.flatMap { $0 }
        var restored = 0
        for raw in raws where hidden[raw.id] == nil && FrameMath.isParked(origin: (raw.frame.x, raw.frame.y), screens: screens) {
            let match = records.first { $0.pid == raw.pid && $0.title == raw.title }
            let target = match?.frame ?? Rect(x: 80, y: 80, width: raw.frame.width, height: raw.frame.height)
            move(raw.id.element, to: FrameMath.restorableFrame(target, screens: screens), resize: match != nil)
            restored += 1
        }
        persist()
        if restored > 0 { Log.windows.notice("recovered \(restored, privacy: .public) stranded windows") }
    }

    private func hide(_ w: ManagedWindow, screens: [Rect]) {
        guard hidden[w.id] == nil else { return }
        // A hung app would hold each call for the full timeout. Its windows stay where they are this time.
        if slowApps.isSlow(w.pid) {
            Log.windows.notice("not hiding a window of \(w.bundleId, privacy: .public): the app is not answering")
            return
        }
        // The cached frame can be seconds old; the window goes back to where it is now, not to where it was.
        var frame = AX.frame(w.id.element) ?? w.frame
        if FrameMath.isParked(origin: (frame.x, frame.y), screens: screens) { frame = w.frame }
        guard let screen = FrameMath.screen(containing: frame, in: screens) else { return }
        let o = FrameMath.offscreenOrigin(for: screen)
        if AX.setPosition(w.id.element, x: o.x, y: o.y) {
            hidden[w.id] = HiddenRecord(key: w.key, pid: w.pid, bundleId: w.bundleId, title: w.title, frame: frame)
        } else {
            Log.windows.error("could not hide a window of \(w.bundleId, privacy: .public)")
        }
    }

    private func unhide(_ w: ManagedWindow, screens: [Rect]) {
        guard let rec = hidden[w.id] else { return }
        restore(w.id, rec, screens: screens)
    }

    private func restore(_ id: ElementID, _ rec: HiddenRecord, screens: [Rect]) {
        let target = FrameMath.restorableFrame(rec.frame, screens: screens)
        move(id.element, to: target, resize: FrameMath.needsResize(saved: rec.frame, target: target))
        hidden[id] = nil
    }

    private func move(_ el: AXUIElement, to f: Rect, resize: Bool) {
        let moved = AX.setPosition(el, x: f.x, y: f.y)
        if resize { AX.setSize(el, width: f.width, height: f.height) }
        if !moved { Log.windows.error("could not move a window back on-screen") }
    }

    private func persist() { store.save(Array(hidden.values)) }

    /// Re-reads each window's desktop just before the raise: it may have moved since the last refresh.
    private func onActiveDesktop(_ wins: [ManagedWindow], target: Int?) -> [ManagedWindow] {
        guard let target else { return wins }
        let list = Spaces.desktops()
        let active = Spaces.isShowingDesktop(target, in: list) ? target : Spaces.activeDesktopNumber(in: list) ?? target
        let live = wins.map { w in (key: w.key, desktop: w.windowNumber.flatMap { Spaces.desktopNumber(ofWindow: $0, in: list) }) }
        let kept = Set(RaiseFilter.onDesktop(live, active: active))
        let strays = wins.filter { !kept.contains($0.key) }
        if !strays.isEmpty {
            Log.windows.notice("show skipped \(strays.count, privacy: .public) windows not on Desktop \(active, privacy: .public): \(strays.map(\.bundleId).joined(separator: ","), privacy: .public)")
        }
        return wins.filter { kept.contains($0.key) }
    }

    /// Every window a manual tidy may lay out (see `ManualTidy`).
    func manualTidyKeys() -> [String] {
        ManualTidy.keys(latest.map { ManualTidy.Candidate(key: $0.key, hidden: hidden[$0.id] != nil) })
    }

    /// Windows a tidy may lay out: listed now and not parked off-screen by Switchyard.
    func tidyCandidates(_ keys: [String]) -> [ManagedWindow] {
        let wanted = Set(keys)
        return latest.filter { wanted.contains($0.key) && hidden[$0.id] == nil }
    }

    /// `frontToBack`: the first window ends on top and gets the keyboard.
    private func raise(_ frontToBack: [ManagedWindow]) async {
        let byKey = Dictionary(frontToBack.map { ($0.key, $0) }, uniquingKeysWith: { first, _ in first })
        for step in RaisePlan.steps(frontToBack.map { RaiseTarget(key: $0.key, pid: $0.pid) }) {
            switch step {
            case .raise(let key):
                guard let w = byKey[key] else { continue }
                AX.perform(w.id.element, kAXRaiseAction as String)
                AX.setBool(w.id.element, kAXMainAttribute as String, true)
            case .activate(let pid):
                await MainActor.run { _ = NSRunningApplication(processIdentifier: pid)?.activate() }
            }
        }
        if let first = frontToBack.first { AX.setBool(first.id.element, kAXFocusedAttribute as String, true) }
    }

    // MARK: Direct actions

    /// Brings one window back on-screen if Switchyard parked it, then raises and focuses it. Hides nothing.
    func focus(key: String) async -> Bool {
        guard let w = await window(forKey: key) else { return false }
        let screens = await MainActor.run { currentScreenFrames() }
        unhide(w, screens: screens)
        persist()
        await raise([w])
        return true
    }

    /// Closes a non-browser window by pressing its close button.
    func close(_ w: ManagedWindow) -> Bool {
        guard let button = AX.element(w.id.element, kAXCloseButtonAttribute as String) else { return false }
        return AX.perform(button, kAXPressAction as String)
    }
}
