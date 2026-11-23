import AppKit
import ApplicationServices

/// What one tidy did.
struct TidyOutcome: Equatable {
    var laidOut = 0
    var refused = 0
    /// Why nothing was laid out, for the menu. nil when the tidy ran or had nothing to do.
    var skipped: String?
}

/// Lays out a desktop's windows (see `Layout`) and keeps one Undo level per desktop.
actor Tidier {
    static let mouseWait: TimeInterval = 2
    /// Layout passes after the first, each around the minimum sizes the windows showed.
    static let maxPasses = 3

    private let windows: WindowLayer
    private let store: TidyStore
    private var memory: TidyMemory
    /// Desktops whose frames did not read back from afar: tidied on the owner's next arrival.
    private var pending: [Int: (keys: [String], slots: [LayoutSlotDTO]?)] = [:]

    init(windows: WindowLayer, store: TidyStore = TidyStore()) {
        self.windows = windows
        self.store = store
        self.memory = store.load()
    }

    func canUndo(desktop: Int) -> Bool { memory.canUndo(desktop: desktop) }

    /// `keys`: the windows that belong on the desktop. Those not really there (or minimized, or hidden) are left out.
    /// `slots`: a layout preset. Its apps' windows go to their slots; the rest get the automatic layout.
    @discardableResult
    func tidy(desktop: Int, keys: [String], force: Bool, slots: [LayoutSlotDTO]? = nil) async -> TidyOutcome {
        if CarrySession.current != nil { return TidyOutcome(skipped: "windows are being carried") }
        guard await Self.mouseButtonsUp() else {
            Log.windows.notice("tidy skipped desktop=\(desktop, privacy: .public): mouse button held")
            return TidyOutcome(skipped: "skipped, a mouse button is held")
        }
        let start = Date()
        _ = await windows.refresh()
        let list = Spaces.desktops()
        let here = await windows.tidyCandidates(keys).filter { w in
            w.windowNumber.flatMap { Spaces.desktopNumber(ofWindow: $0, in: list) } == desktop
        }
        guard let entry = list.first(where: { $0.number == desktop }), let display = Spaces.displayId(of: entry) else {
            return TidyOutcome(skipped: "cannot find Desktop \(desktop)'s screen")
        }
        guard let screen = await MainActor.run(body: { Self.screen(display) }) else { return TidyOutcome(skipped: "no screen") }
        let preset = (slots?.isEmpty ?? true) ? nil : slots
        let sharedSpaces = entry.displayId == "Main"
        let screens = await MainActor.run(body: { PresetScreens.current() })
        // One set of Spaces across displays ("Main"): the desktop spans every screen, so every window on it counts.
        // Separate Spaces: only windows on the desktop's own screen (one may hang off it).
        let candidates = sharedSpaces && !screens.isEmpty ? here : here.filter { screen.frame.intersects($0.frame) }
        let keySet = Set(candidates.map(\.key))
        let fingerprint = TidyGate.fingerprint(preset)
        guard TidyGate.shouldRun(keys: keySet, last: memory.lastKeys(desktop: desktop), force: force,
                                 preset: fingerprint, lastPreset: memory.lastPreset(desktop: desktop)) else { return TidyOutcome() }

        let z = Spaces.zOrder()
        var before: [String: Rect] = [:]
        for w in candidates { before[w.key] = AX.frame(w.id.element) ?? w.frame }
        memory.record(desktop: desktop, before: before, keys: keySet, preset: fingerprint)
        store.save(memory)

        var outcome = TidyOutcome()
        var unread = 0
        var targeted = 0
        var auto = candidates
        if let preset {
            let placed = candidates.map {
                PresetWindow(key: $0.key, bundleId: $0.bundleId, z: $0.windowNumber.flatMap { z[$0] } ?? Int.max, number: $0.windowNumber ?? 0)
            }
            let frames = PresetLayout.assign(placed, slots: preset, screens: screens,
                                             scope: sharedSpaces ? .anyScreen : .only(Spaces.displayUUID(display)))
            for w in candidates {
                guard let f = frames[w.key] else { continue }
                targeted += 1
                Self.setFrame(w.id.element, f)
                let area = FrameMath.screen(containing: f, in: screens.map(\.frame)).flatMap { hit in screens.first { $0.frame == hit }?.area }
                Self.judge(w, slot: f, got: AX.frame(w.id.element), area: area ?? screen.area, outcome: &outcome, unread: &unread)
            }
            let rest = Set(PresetLayout.unslotted(placed, slots: preset))
            auto = candidates.filter { rest.contains($0.key) }
        }
        // The automatic layout runs once per screen the windows are on.
        let groups: [(frame: Rect, area: Rect, wins: [ManagedWindow])]
        if sharedSpaces && !screens.isEmpty {
            let byScreen = TidyScreens.group(auto.map { (key: $0.key, frame: $0.frame) }, screens: screens.map(\.frame))
            groups = byScreen.keys.sorted().map { i in
                (screens[i].frame, screens[i].area, auto.filter { byScreen[i]?.contains($0.key) ?? false })
            }
        } else {
            groups = [(screen.frame, screen.area, auto)]
        }
        for g in groups where !g.wins.isEmpty {
            targeted += g.wins.count
            let done = autoLayout(g.wins, z: z, screen: (g.frame, g.area), desktop: desktop)
            outcome.laidOut += done.outcome.laidOut
            outcome.refused += done.outcome.refused
            unread += done.unread
        }
        if unread > 0 && unread == targeted { pending[desktop] = (keys, slots) }
        var after: [String: Rect] = [:]
        for w in candidates { if let f = AX.frame(w.id.element) { after[w.key] = f } }
        memory.recordResult(desktop: desktop, after: after)
        store.save(memory)
        let ms = Int(Date().timeIntervalSince(start) * 1000)
        Log.timing.notice("tidy desktop=\(desktop, privacy: .public) windows=\(candidates.count, privacy: .public) preset=\(preset != nil, privacy: .public) applied=\(outcome.laidOut, privacy: .public) refused=\(outcome.refused, privacy: .public) unread=\(unread, privacy: .public) ms=\(ms, privacy: .public)")
        return outcome
    }

    /// The automatic layout (see `Layout`) on one screen, with passes around minimum sizes.
    private func autoLayout(_ list: [ManagedWindow], z: [UInt32: Int], screen: (frame: Rect, area: Rect),
                            desktop: Int) -> (outcome: TidyOutcome, unread: Int) {
        let order = Layout.pickMain(list.map {
            LayoutWindow(key: $0.key, bundleId: $0.bundleId, z: $0.windowNumber.flatMap { z[$0] } ?? Int.max, number: $0.windowNumber ?? 0)
        })
        let byKey = Dictionary(list.map { ($0.key, $0) }, uniquingKeysWith: { a, _ in a })
        let wins = order.compactMap { byKey[$0] }
        var minimums: [Int: Size] = [:]
        var slots = Layout.frames(count: wins.count, area: screen.area)
        var got = Self.apply(wins, slots)
        // A window that would not shrink (Discord's minimum, say): lay out again around the sizes learned so far.
        for _ in 0..<Self.maxPasses {
            let learned = Layout.minimums(slots: slots, got: got.map { $0 ?? Rect(x: 0, y: 0, width: 0, height: 0) })
            guard !learned.isEmpty else { break }
            minimums.merge(learned) { a, b in Size(width: max(a.width, b.width), height: max(a.height, b.height)) }
            let next = Layout.frames(count: wins.count, area: screen.area, minimums: minimums)
            let changed = Layout.changedSlots(from: slots, to: next)
            guard !changed.isEmpty else { break }
            slots = next
            // Only windows whose slot moved are set again, so the rest do not jump.
            for i in changed where i < wins.count && i < got.count {
                Self.setFrame(wins[i].id.element, slots[i])
                got[i] = AX.frame(wins[i].id.element)
            }
        }
        var outcome = TidyOutcome()
        var unread = 0
        for (w, (slot, g)) in zip(wins, zip(slots, got)) {
            Self.judge(w, slot: slot, got: g, area: screen.area, outcome: &outcome, unread: &unread)
        }
        // Deck: raise top to bottom so every title bar shows. Only here, and never activating an app.
        if slots.count >= 3, slots[1].intersects(slots[2]), Spaces.isShowingDesktop(desktop) {
            for w in wins.dropFirst() { AX.perform(w.id.element, kAXRaiseAction as String) }
        }
        return (outcome, unread)
    }

    /// A tidy that could not reach another desktop runs once when the owner arrives there.
    func runPending(desktop: Int) async {
        guard let job = pending.removeValue(forKey: desktop) else { return }
        await tidy(desktop: desktop, keys: job.keys, force: true, slots: job.slots)
    }

    /// Puts back the frames from before the last tidy of the desktop. Returns how many windows moved.
    @discardableResult
    func undo(desktop: Int) async -> Int {
        let frames = memory.takeUndo(desktop: desktop)
        store.save(memory)
        guard !frames.isEmpty else { return 0 }
        let wins = await windows.tidyCandidates(Array(frames.keys))
        for w in wins { if let f = frames[w.key] { Self.setFrame(w.id.element, f) } }
        Log.timing.notice("tidy undo desktop=\(desktop, privacy: .public) windows=\(wins.count, privacy: .public)")
        return wins.count
    }

    /// Sets each frame and reads it back (nil: the window did not answer). A window smaller than its slot
    /// (a terminal's cell grid) counts as placed; one that stayed larger is laid out around on the second pass.
    private static func apply(_ wins: [ManagedWindow], _ slots: [Rect]) -> [Rect?] {
        zip(wins, slots).map { w, slot in
            setFrame(w.id.element, slot)
            return AX.frame(w.id.element)
        }
    }

    /// Counts a placed window. A window smaller than its slot (a terminal's cell grid) counts as placed; one that
    /// stayed larger is refused and moved so it does not hang off the area.
    private static func judge(_ w: ManagedWindow, slot: Rect, got: Rect?, area: Rect, outcome: inout TidyOutcome, unread: inout Int) {
        guard let g = got else { unread += 1; return }
        if close(g, slot) || (g.width <= slot.width && g.height <= slot.height) { outcome.laidOut += 1; return }
        outcome.refused += 1
        let fitted = Layout.fit(g, slot: slot, area: area)
        AX.setPosition(w.id.element, x: fitted.x, y: fitted.y)
        Log.windows.notice("tidy refused key=\(w.bundleId, privacy: .public) wanted=\(Int(slot.width), privacy: .public)x\(Int(slot.height), privacy: .public) got=\(Int(g.width), privacy: .public)x\(Int(g.height), privacy: .public)")
    }

    private static func setFrame(_ el: AXUIElement, _ f: Rect) {
        AX.setSize(el, width: f.width, height: f.height)
        AX.setPosition(el, x: f.x, y: f.y)
        AX.setSize(el, width: f.width, height: f.height)
    }

    private static func close(_ a: Rect, _ b: Rect) -> Bool {
        abs(a.x - b.x) <= 2 && abs(a.y - b.y) <= 2 && abs(a.width - b.width) <= 2 && abs(a.height - b.height) <= 2
    }

    private static func mouseButtonsUp() async -> Bool {
        let deadline = Date().addingTimeInterval(mouseWait)
        while NSEvent.pressedMouseButtons != 0 {
            if Date() > deadline { return false }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        return true
    }

    /// The screen showing `display`, else the main one, in Accessibility coordinates, and its usable area.
    @MainActor
    private static func screen(_ display: CGDirectDisplayID) -> (frame: Rect, area: Rect)? {
        guard let primary = NSScreen.screens.first else { return nil }
        let number = NSDeviceDescriptionKey("NSScreenNumber")
        let main = NSScreen.screens.first { ($0.deviceDescription[number] as? NSNumber)?.uint32Value == display } ?? primary
        let h = primary.frame.height
        let f = main.frame, v = main.visibleFrame
        return (FrameMath.fromCocoa(Rect(x: f.minX, y: f.minY, width: f.width, height: f.height), primaryHeight: h),
                Layout.area(visibleFrame: Rect(x: v.minX, y: v.minY, width: v.width, height: v.height), primaryHeight: h))
    }
}
