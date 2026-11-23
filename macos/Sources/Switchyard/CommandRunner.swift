import AppKit
import Foundation

enum CommandError: Error, LocalizedError {
    case unknownType(String)
    case missing(String)
    case windowNotFound(String)
    case notBrowserWindow
    case unsupported(String)

    var errorDescription: String? {
        switch self {
        case .unknownType(let t): return "unknown command type '\(t)'"
        case .missing(let f): return "command is missing '\(f)'"
        case .windowNotFound(let k): return "window not found: \(k)"
        case .notBrowserWindow: return "window is not a Chrome or Arc window"
        case .unsupported(let m): return m
        }
    }
}

/// A `moveWindows` that did not move everything. The ack names the windows that failed.
struct MoveFailure: Error, LocalizedError {
    let message: String
    let failedKeys: [String]
    var errorDescription: String? { message }
}

/// Executes server commands one at a time.
struct CommandRunner {
    let windows: WindowLayer
    let tidier: Tidier
    let browsers = BrowserLayer()
    /// "Sorting 3 of 10", called on the main actor; (0, 0) when done.
    var progress: @MainActor (Int, Int) -> Void = { _, _ in }
    /// The windows that belong on a desktop, given the windows just carried.
    var tidyKeys: @MainActor (Int, [WindowMoveDTO]) -> [String] = { _, _ in [] }
    /// After a show that went to a desktop: the bounce check.
    var shown: @MainActor (Int) -> Void = { _ in }
    /// After a tidy: what it did, for the menu.
    var tidied: @MainActor (Int, TidyOutcome) -> Void = { _, _ in }

    private var desktops: DesktopCommands { DesktopCommands(windows: windows) }

    /// `raise`: for a `show`, the windows to bring to the front (front first). The caller decides, because a
    /// show that only repeats a switch the app already made must not raise the same windows again.
    func execute(_ cmd: AppCommand, raise: [String] = []) async throws {
        switch cmd.type {
        case "show": try await show(cmd, raise: raise)
        case "showAll": await windows.restoreAll()
        case "moveWindows": try await moveWindows(cmd)
        case "splitTabs": try await splitTabs(cmd)
        case "tidy": await tidy(cmd)
        case "undoTidy":
            guard let desktop = cmd.desktop else { throw CommandError.missing("desktop") }
            await tidier.undo(desktop: desktop)
            await tidied(desktop, TidyOutcome())
        case "nameWindow": try await nameWindow(cmd)
        case "openWindow": try await openWindow(cmd)
        case "closeWindow": try await closeWindow(cmd)
        case "focusWindow": try await focusWindow(cmd)
        case "openTab": try await openTab(cmd)
        case "closeTab": try await closeTab(cmd)
        default: throw CommandError.unknownType(String(cmd.type.prefix(40)))
        }
    }

    private func show(_ cmd: AppCommand, raise: [String]) async throws {
        let sets = try ShowPlan.sets(for: cmd)
        let start = Date()
        // Only a switch the owner asked for goes to the desktop; a re-apply (focus false) never takes the screen.
        var desktopMs = 0
        if cmd.focus, let number = cmd.desktop { desktopMs = try await desktops.goTo(number) }
        var t = await windows.show(sets, raise: raise, desktop: cmd.focus ? cmd.desktop : nil)
        t.desktopMs = Double(desktopMs)
        SwitchLog.show(source: "server", trigger: cmd.createdAt, start: start, timing: t)
        if cmd.focus, let number = cmd.desktop { await shown(number) }
    }

    private func moveWindows(_ cmd: AppCommand) async throws {
        guard !cmd.moves.isEmpty else { return }
        let result = await desktops.move(cmd.moves, progress: progress)
        await progress(0, 0)
        SwitchLog.sort(result)
        for desktop in cmd.tidy {
            let keys = await tidyKeys(desktop, cmd.moves)
            await tidied(desktop, await tidier.tidy(desktop: desktop, keys: keys, force: false))
        }
        if !result.ok { throw MoveFailure(message: result.errorText ?? "not every window moved", failedKeys: result.failed.map(\.key)) }
    }

    private func splitTabs(_ cmd: AppCommand) async throws {
        let failed = await TabSplitter(windows: windows, desktops: desktops).run(cmd.splits)
        let asked = cmd.splits.reduce(0) { $0 + $1.tabs.count }
        Log.timing.notice("split tabs asked=\(asked, privacy: .public) failed=\(failed.count, privacy: .public)")
        if !failed.isEmpty { throw CommandError.unsupported("could not move \(failed.count) of \(asked) tabs to their own window") }
    }

    private func tidy(_ cmd: AppCommand) async {
        for d in cmd.tidyDesktops {
            await tidied(d.desktop, await tidier.tidy(desktop: d.desktop, keys: d.windowKeys, force: cmd.force))
        }
    }

    /// The browser, the process that owns the window, and the browser's id for it.
    private func browserTarget(_ cmd: AppCommand) async throws -> (BrowserKind, pid_t, String) {
        guard let key = cmd.windowKey else { throw CommandError.missing("windowKey") }
        guard let w = await windows.window(forKey: key) else { throw CommandError.windowNotFound(key) }
        guard let kind = BrowserKind(rawValue: w.bundleId), let b = w.browser else { throw CommandError.notBrowserWindow }
        return (kind, w.pid, b.windowId)
    }

    private func nameWindow(_ cmd: AppCommand) async throws {
        guard let name = cmd.name else { throw CommandError.missing("name") }
        let (kind, pid, id) = try await browserTarget(cmd)
        try await browsers.setName(kind, pid: pid, windowId: id, name: name)
    }

    private func openWindow(_ cmd: AppCommand) async throws {
        guard let b = cmd.browser, let kind = BrowserKind.parse(b) else { throw CommandError.missing("browser") }
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: kind.rawValue)
            .map { (pid: $0.processIdentifier, launched: $0.launchDate) }
        guard let pid = BrowserInstances.forNewWindow(running: running, answering: await windows.answeringBrowsers(kind)) else {
            throw CommandError.unsupported("\(kind == .chrome ? "Chrome" : "Arc") is not running")
        }
        try await browsers.openWindow(kind, pid: pid, name: cmd.name, urls: cmd.urls)
    }

    private func closeWindow(_ cmd: AppCommand) async throws {
        guard let key = cmd.windowKey else { throw CommandError.missing("windowKey") }
        guard let w = await windows.window(forKey: key) else { throw CommandError.windowNotFound(key) }
        if let kind = BrowserKind(rawValue: w.bundleId), let b = w.browser {
            try await browsers.closeWindow(kind, pid: w.pid, windowId: b.windowId)
        } else if await !windows.close(w) {
            throw CommandError.unsupported("window has no close button")
        }
    }

    /// Goes to the window's desktop if it is on another one, then un-hides, raises and focuses it.
    private func focusWindow(_ cmd: AppCommand) async throws {
        guard let key = cmd.windowKey else { throw CommandError.missing("windowKey") }
        guard let w = await windows.window(forKey: key) else { throw CommandError.windowNotFound(key) }
        if let number = FocusPlan.desktopToVisit(window: w.desktop, active: Spaces.activeDesktopNumber()) {
            _ = try await desktops.goTo(number)
        }
        guard await windows.focus(key: key) else { throw CommandError.windowNotFound(key) }
    }

    private func openTab(_ cmd: AppCommand) async throws {
        guard let url = cmd.url else { throw CommandError.missing("url") }
        let (kind, pid, id) = try await browserTarget(cmd)
        try await browsers.openTab(kind, pid: pid, windowId: id, url: url)
    }

    private func closeTab(_ cmd: AppCommand) async throws {
        guard let tab = cmd.tabId else { throw CommandError.missing("tabId") }
        let (kind, pid, id) = try await browserTarget(cmd)
        try await browsers.closeTab(kind, pid: pid, windowId: id, tabId: tab)
    }
}

/// One log line per show, so a slow switch can be explained from `log show` without moving any window.
enum SwitchLog {
    /// `trigger`: the key press or click (app clock) or the moment the server queued the command.
    static func show(source: String, trigger: Date?, start: Date, timing t: ShowTiming) {
        let waitMs = trigger.map { start.timeIntervalSince($0) * 1000 } ?? -1
        let frontMs = max(waitMs, 0) + t.desktopMs + t.restoreMs + t.raiseMs
        let totalMs = frontMs + t.hideMs
        Log.timing.notice("""
            show source=\(source, privacy: .public) front=\(Int(frontMs), privacy: .public)ms \
            (wait=\(Int(waitMs), privacy: .public) desktop=\(Int(t.desktopMs), privacy: .public) restore=\(Int(t.restoreMs), privacy: .public) raise=\(Int(t.raiseMs), privacy: .public)) \
            hide=\(Int(t.hideMs), privacy: .public)ms total=\(Int(totalMs), privacy: .public)ms \
            windows shown=\(t.shown, privacy: .public) raised=\(t.raised, privacy: .public) hidden=\(t.hidden, privacy: .public) restored=\(t.restored, privacy: .public)
            """)
    }

    static func sort(_ r: MoveResult) {
        let attempted = max(r.moved + r.failed.count, 1)
        Log.timing.notice("sort carried=\(r.moved, privacy: .public) failed=\(r.failed.count, privacy: .public) left=\(r.leftOver, privacy: .public) total=\(r.milliseconds, privacy: .public)ms perWindow=\(r.milliseconds / attempted, privacy: .public)ms aborted=\(r.aborted ?? "no", privacy: .public)")
    }
}
