import AppKit
import Foundation

@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()

    @Published private(set) var contexts: [ContextDTO] = []
    @Published private(set) var waitingCount = 0
    /// The context whose windows are in front, as far as the app knows. Set at once on a local switch.
    @Published private(set) var activeContextId: String?
    @Published private(set) var unsortedCount = 0
    @Published private(set) var serverProblem: String?
    @Published private(set) var trusted = AX.isTrusted(prompt: false)
    /// The last menu or hotkey action that failed, shown in the menu until an action works again.
    @Published private(set) var actionProblem: String?
    /// "Sorting 3 of 10 · Esc stops" while windows are carried between desktops.
    @Published private(set) var sortProgress: String?
    /// Sorted windows on the wrong desktop.
    @Published private(set) var toSortCount = 0
    /// The current desktop has an Undo for its last tidy.
    @Published private(set) var canUndoTidy = false
    @Published private(set) var unsorted: [WindowRef] = []
    /// Names of the saved layout presets, for the default name of the next one.
    @Published private(set) var layoutNames: [String] = []

    private let config = AppConfig.load()
    private lazy var api = APIClient(config: config)
    private let windows = WindowLayer()
    private lazy var snapshots = SnapshotLoop(windows: windows, api: api)
    private lazy var tidier = Tidier(windows: windows)
    private lazy var runner = CommandRunner(
        windows: windows, tidier: tidier,
        progress: { [weak self] done, total in
            self?.sortProgress = total == 0 ? nil : "Sorting \(min(done + 1, total)) of \(total) · Esc stops"
        },
        tidyKeys: { [weak self] desktop, moves in
            guard let self else { return [] }
            return TidyTargets.keys(contexts: self.contexts, desktop: desktop, activeContextId: self.activeContextId, moves: moves)
        },
        tidySlots: { [weak self] desktop in self?.presetSlots(desktop: desktop) },
        saveLayout: { [weak self] name in try await self?.captureAndSave(name: name) },
        shown: { [weak self] desktop in self?.watchBounce(target: desktop) },
        tidied: { [weak self] desktop, outcome in self?.noteTidy(desktop: desktop, outcome) })
    private let hud = DesktopHUD()
    private var desktopMode = false
    /// Bumped by every switch, so a bounce check from an older switch does nothing.
    private var bounceGeneration = 0
    private var spaceObserver: NSObjectProtocol?
    private let notifier = Notifier()
    private let switcher = SwitcherController()
    private var previousStatus: [String: String]?
    private var echo = ShowEcho()
    /// Browser scripts run here one after another, so a slow one never delays a window command.
    private var slowLane: Task<Void, Never>?
    private var tasks: [Task<Void, Never>] = []
    private var signalSources: [DispatchSourceSignal] = []
    private var started = false

    func start() {
        guard !started else { return }
        started = true
        AX.configureTimeouts()
        DesktopKeys.undoLeftovers()
        if !trusted { trusted = AX.isTrusted(prompt: true) } // first run: show the system prompt
        notifier.onOpen = { [weak self] id in self?.switchTo(id) }
        notifier.start()
        switcher.onPick = { [weak self] id in self?.switchTo(id) }
        registerHotkeys()
        installSignalHandlers()
        snapshots.start()
        // Swiping desktops by hand: report at once so the active context follows.
        spaceObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { [weak self, snapshots] _ in
            snapshots.nudge()
            MainActor.assumeIsolated { self?.arrived() }
        }
        tasks.append(Task { await pollContexts() })
        tasks.append(Task { await commandLoop() })
    }

    // MARK: Menu actions

    func requestAccessibility() {
        trusted = AX.isTrusted(prompt: true)
        if !trusted, let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
            NSWorkspace.shared.open(url)
        }
    }

    func openDashboard() {
        let url = config.serverURL
        Task.detached { await DashboardTabs.open(url) }
    }

    /// Moves the windows at once from what the app already knows, then tells the server. The server's own
    /// `show` follows a few milliseconds later and only corrects what the local view got wrong.
    /// `trigger`: when the owner pressed the key or clicked.
    func switchTo(_ contextId: String, trigger: Date = Date()) {
        if sortProgress != nil {
            actionProblem = "Sorting windows. Press Esc to stop it first."
            NSSound.beep()
            return
        }
        act("Switch") {
            if self.trusted, let plan = LocalSwitch.plan(contexts: self.contexts, target: contextId) {
                let signpost = Log.signposts.beginInterval("switch")
                let start = Date()
                self.activeContextId = contextId
                var desktopMs = 0
                if let number = plan.desktop { desktopMs = try await DesktopCommands(windows: self.windows).goTo(number) }
                var timing = await self.windows.show(plan.sets, raise: plan.order, desktop: plan.desktop)
                timing.desktopMs = Double(desktopMs)
                Log.signposts.endInterval("switch", signpost)
                self.echo.recordLocal(contextId: contextId, raised: Set(plan.order), at: Date())
                SwitchLog.show(source: "local", trigger: trigger, start: start, timing: timing)
                if let number = plan.desktop { self.watchBounce(target: number) }
            }
            try await self.api.switchContext(id: contextId)
        }
    }

    /// ⌥T and the panel button: lays out every window on the current desktop (works with the server down).
    func tidyHere() {
        if sortProgress != nil { actionProblem = "Sorting windows. Press Esc to stop it first."; NSSound.beep(); return }
        act("Tidy") {
            guard let desktop = Spaces.activeDesktopNumber() else { throw CommandError.unsupported("this space is not a desktop") }
            _ = await self.windows.refresh()
            let keys = await self.windows.manualTidyKeys()
            let outcome = await self.tidier.tidy(desktop: desktop, keys: keys, force: true, slots: self.presetSlots(desktop: desktop))
            self.noteTidy(desktop: desktop, outcome)
            self.snapshots.nudge()
            if let skipped = outcome.skipped { throw CommandError.unsupported(skipped) }
        }
    }

    /// "Save layout…" in the panel: asks for a name, then saves the desktop on screen as a preset.
    func saveLayoutPrompt() {
        guard let name = LayoutNamePrompt.ask(defaultName: LayoutNames.next(taken: layoutNames)) else { return }
        act("Save layout") { try await self.captureAndSave(name: name) }
    }

    private func presetSlots(desktop: Int) -> [LayoutSlotDTO]? {
        TidyTargets.slots(contexts: contexts, desktop: desktop, activeContextId: activeContextId)
    }

    /// Reads the windows on the desktop on screen and posts them as a preset.
    private func captureAndSave(name: String) async throws {
        let slots = try await LayoutCapture(windows: windows).slots()
        try await api.saveLayout(name: name, slots: slots)
    }

    func undoTidy() {
        act("Undo tidy") {
            guard let desktop = Spaces.activeDesktopNumber() else { return }
            await self.tidier.undo(desktop: desktop)
            self.canUndoTidy = false
            self.snapshots.nudge()
        }
    }

    private func noteTidy(desktop: Int, _ outcome: TidyOutcome) {
        if let skipped = outcome.skipped { actionProblem = "Tidy: \(skipped)" }
        Task { canUndoTidy = await tidier.canUndo(desktop: Spaces.activeDesktopNumber() ?? desktop) }
    }

    // MARK: Arriving on a desktop

    /// 300 ms after a switch: if the screen left the target desktop, go back once, without raising anything.
    private func watchBounce(target: Int) {
        bounceGeneration += 1
        let generation = bounceGeneration
        Task {
            var corrected = false
            while true {
                try? await Task.sleep(nanoseconds: UInt64(ShowBounce.checkDelay * 1_000_000_000))
                guard generation == bounceGeneration, sortProgress == nil else { return }
                let landed = Spaces.isShowingDesktop(target) ? target : Spaces.activeDesktopNumber()
                switch ShowBounce.decide(target: target, landed: landed, alreadyCorrected: corrected) {
                case .ok: return
                case .giveUp:
                    Log.timing.error("show bounced again target=\(target, privacy: .public) landed=\(landed ?? 0, privacy: .public); giving up")
                    return
                case .goBack:
                    Log.timing.error("show bounced target=\(target, privacy: .public) landed=\(landed ?? 0, privacy: .public)")
                    corrected = true
                    _ = try? await DesktopCommands(windows: windows).goTo(target)
                }
            }
        }
    }

    /// The arrival HUD, the Undo state of this desktop, and a tidy that waited for the owner to come here.
    private func arrived() {
        guard desktopMode, sortProgress == nil, CarrySession.current == nil, let desktop = Spaces.activeDesktopNumber() else { return }
        let here = contexts.filter { $0.desktop == desktop }
        let shared = here.contains(where: \.desktopShared)
        let owner = shared ? here.first { $0.id == activeContextId } : here.first
        let sharedDesktop = contexts.first(where: \.desktopShared)?.desktop ?? DesktopList.usableCount(Spaces.desktops())
        let unsortedHere = owner == nil || shared ? 0 : unsorted.filter { $0.desktop == desktop }.count
        hud.show(HUDText.make(contextName: owner?.name, desktop: desktop, shared: shared,
                              strays: owner.map(ContextStrays.desktops) ?? [], unsortedHere: unsortedHere, sharedDesktop: sharedDesktop))
        Task {
            await tidier.runPending(desktop: desktop)
            canUndoTidy = await tidier.canUndo(desktop: desktop)
        }
    }

    func sortWindows() {
        act("Sort windows") { try await self.api.sortWindows() }
    }

    /// Restores locally first (works with the server down), then tells the server so it stops re-hiding windows.
    func showAllWindows() {
        act("Show all windows") {
            await self.windows.restoreAll()
            self.activeContextId = nil
            self.snapshots.nudge()
            try await self.api.showAll()
        }
    }

    func copyAccessCode() {
        act("Copy access code") {
            let code = try await self.api.fetchAccessCode()
            NSPasteboard.general.setSecret(code)
        }
    }

    func quit() {
        Task {
            Self.letGoOfEverything()
            await windows.restoreAll()
            NSApp.terminate(nil)
        }
    }

    /// Runs a menu or hotkey action. A failure is logged and stays visible in the menu; it is never silent.
    private func act(_ what: String, _ work: @escaping @MainActor () async throws -> Void) {
        Task {
            do {
                try await work()
                actionProblem = nil
            } catch {
                actionProblem = "\(what) failed: \(Self.plain(error))"
                Log.app.error("\(what, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    // MARK: Hotkeys and signals

    private func registerHotkeys() {
        let hk = HotkeyCenter.shared
        hk.registerOption(keyCode: HotkeyCenter.tidyKeyCode) { [weak self] _ in self?.tidyHere() }
        hk.registerOption(keyCode: HotkeyCenter.spaceKeyCode) { [weak self] _ in
            guard let self else { return }
            self.switcher.toggle(contexts: self.contexts)
        }
        for (i, code) in HotkeyCenter.digitKeyCodes.enumerated() {
            hk.registerOption(keyCode: code) { [weak self] pressed in
                guard let self else { return }
                guard let c = self.contexts.first(where: { $0.key == i + 1 }) else {
                    self.actionProblem = "No context on ⌥\(i + 1)"
                    NSSound.beep()
                    return
                }
                self.switchTo(c.id, trigger: pressed)
            }
        }
    }

    private func installSignalHandlers() {
        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            src.setEventHandler { [weak self] in
                Self.letGoOfEverything()
                guard let self else { exit(0) }
                Task { await self.windows.restoreAll(); exit(0) }
            }
            src.resume()
            signalSources.append(src)
        }
    }

    /// Mid-carry quit: mouse up, pointer back, desktop shortcuts back off.
    nonisolated static func letGoOfEverything() {
        if let session = CarrySession.current {
            session.abort("Switchyard is quitting")
            session.releaseMouse()
        }
        HotKeyLease.shared.releaseAll()
    }

    // MARK: Loops

    private func pollContexts() async {
        while !Task.isCancelled {
            trusted = AX.isTrusted(prompt: false)
            do {
                apply(try await api.fetchContexts())
                serverProblem = nil
            } catch is CancellationError {
                return
            } catch {
                serverProblem = Self.plain(error)
            }
            try? await Task.sleep(nanoseconds: 3_000_000_000)
        }
    }

    private func apply(_ r: ContextsResponse) {
        contexts = r.contexts
        waitingCount = r.waitingCount
        activeContextId = r.activeContextId
        unsortedCount = r.unsortedCount
        unsorted = r.unsorted
        desktopMode = r.desktopMode
        layoutNames = r.layoutNames
        toSortCount = r.desktopMode ? r.toSort : 0
        let current = Dictionary(r.contexts.map { ($0.id, $0.status) }, uniquingKeysWith: { a, _ in a })
        if let before = previousStatus {
            for c in r.contexts where c.status == "waiting" && before[c.id] != "waiting" {
                notifier.notifyWaiting(contextId: c.id, name: c.name)
            }
        }
        previousStatus = current // the first load never notifies
    }

    private func commandLoop() async {
        var since: Int? = nil
        var backoff: UInt64 = 1
        while !Task.isCancelled {
            do {
                let result = try await api.fetchCommands(since: since)
                backoff = 1
                if since == nil { since = result.lastSeq ?? 0; continue }
                for cmd in result.commands.sorted(by: { $0.seq < $1.seq }) {
                    if CommandLane.of(cmd.type) == .windows { await run(cmd) } else { runInSlowLane(cmd) }
                    since = max(since ?? 0, cmd.seq)
                }
            } catch is CancellationError {
                return
            } catch {
                try? await Task.sleep(nanoseconds: backoff * 1_000_000_000)
                backoff = min(backoff * 2, 10)
            }
        }
    }

    private func runInSlowLane(_ cmd: AppCommand) {
        let previous = slowLane
        slowLane = Task { [weak self] in
            await previous?.value
            await self?.run(cmd)
        }
    }

    private func run(_ cmd: AppCommand) async {
        var failure: String?
        var raise: [String] = []
        if cmd.type == "show" {
            switch echo.decide(contextId: cmd.contextId, focus: cmd.focus, windowKeys: cmd.windowKeys, now: Date()) {
            case .apply(let keys): raise = keys
            case .skip:
                // The owner has already switched somewhere else; this command would flip the screen back.
                do { try await api.ack(seq: cmd.seq, ok: true, error: nil) } catch {
                    Log.app.error("ack \(cmd.seq, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
                }
                return
            }
        }
        var failedKeys: [String] = []
        do { try await runner.execute(cmd, raise: raise) } catch {
            failure = error.localizedDescription
            if let move = error as? MoveFailure {
                failedKeys = move.failedKeys
                actionProblem = "Sort: \(move.message)"
            }
            Log.app.error("command \(cmd.seq, privacy: .public) (\(cmd.type, privacy: .public)) failed: \(error.localizedDescription, privacy: .public)")
        }
        do { try await api.ack(seq: cmd.seq, ok: failure == nil, error: failure, failedKeys: failedKeys) } catch {
            Log.app.error("ack \(cmd.seq, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
        }
        snapshots.nudge()
    }

    static func plain(_ error: Error) -> String {
        if case APIError.unreachable = error { return "Server not reachable" }
        if case APIError.config(let c, _) = error { return c.localizedDescription }
        return error.localizedDescription
    }
}

extension NSPasteboard {
    /// Marks the string concealed and transient (nspasteboard.org) so clipboard managers neither show nor keep it.
    func setSecret(_ value: String) {
        let markers: [NSPasteboard.PasteboardType] = [.init("org.nspasteboard.ConcealedType"), .init("org.nspasteboard.TransientType")]
        declareTypes([.string] + markers, owner: nil)
        setString(value, forType: .string)
        for marker in markers { setData(Data(), forType: marker) }
    }
}
