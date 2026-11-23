import Foundation

/// The status lines at the top of the menu: what is wrong and the next step. Pure, so it is tested.
enum MenuStatus {
    static let cliStartCommand = "switchyard install-service"

    /// The command that installs the server as a login service: the copy inside the app when there is one
    /// (the release .dmg bundles it), else the CLI.
    static func startCommand(bundledEntry: String?) -> String {
        guard let entry = bundledEntry else { return cliStartCommand }
        return "node \"\(entry)\" install-service"
    }

    /// `Contents/Resources/server/src/index.ts` when this app bundle carries the server.
    static var bundledServerEntry: String? {
        guard let resources = Bundle.main.resourceURL else { return nil }
        let entry = resources.appendingPathComponent("server/src/index.ts").path
        return FileManager.default.fileExists(atPath: entry) ? entry : nil
    }

    static func lines(serverProblem: String?, trusted: Bool, contextCount: Int,
                      startCommand: String = cliStartCommand) -> [String] {
        if let problem = serverProblem {
            return [problem, "Start it with: \(startCommand)"]
        }
        if !trusted {
            return ["Windows can't be moved yet", "Allow Switchyard under Privacy & Security › Accessibility"]
        }
        if contextCount == 0 {
            return ["No contexts yet", "Start Claude Code in a project folder and it appears here"]
        }
        return []
    }
}

/// The parts of the menu bar panel that need no view: labels, selection, health. Pure, so it is tested.
enum MenuPanelLogic {
    enum Tone: Equatable { case working, waiting, idle, parked }

    enum Fix: Equatable {
        case allowAccessibility
        case command(String)
    }

    enum Health: Equatable {
        case ok
        case problem(String, fix: Fix)
    }

    static func tone(_ status: String) -> Tone {
        switch status {
        case "working": return .working
        case "waiting": return .waiting
        case "parked": return .parked
        default: return .idle
        }
    }

    static func windowCount(_ n: Int) -> String { n == 1 ? "1 window" : "\(n) windows" }

    static func shortcut(_ c: ContextDTO) -> String? { c.key.map { "⌥\($0)" } }

    /// The second line of a row, e.g. "waiting on you · 3 windows · Desktop 2".
    static func detail(_ c: ContextDTO) -> String {
        let base = "\(StatusDot.label(c.status)) · \(windowCount(c.windows.count))"
        return desktopText(c).map { "\(base) · \($0)" } ?? base
    }

    static func desktopText(_ c: ContextDTO) -> String? {
        c.desktop.map { "Desktop \($0)" + (c.desktopShared ? " (shared)" : "") }
    }

    static func toSortText(_ count: Int) -> String? {
        guard count > 0 else { return nil }
        return count == 1 ? "1 window to sort" : "\(count) windows to sort"
    }

    /// What VoiceOver reads for a row, e.g. "Tala, waiting on you, 3 windows, Option 2".
    static func accessibilityLabel(_ c: ContextDTO) -> String {
        var parts = [c.name, StatusDot.label(c.status), windowCount(c.windows.count)]
        if let d = desktopText(c) { parts.append(d) }
        if let k = c.key { parts.append("Option \(k)") }
        return parts.joined(separator: ", ")
    }

    /// Same matching as the ⌥Space switcher.
    static func visibleRows(_ contexts: [ContextDTO], query: String) -> [ContextDTO] {
        ContextFilter.filter(contexts, query: query)
    }

    /// ↑/↓ through `count` rows, wrapping like the switcher. From no selection, down starts at the top, up at the bottom.
    static func move(selection: Int?, by delta: Int, count: Int) -> Int? {
        guard count > 0 else { return nil }
        guard let s = selection, (0..<count).contains(s) else { return delta >= 0 ? 0 : count - 1 }
        return ((s + delta) % count + count) % count
    }

    /// The context Return switches to: the selected row, or the top match when nothing valid is selected.
    static func pick(rows: [ContextDTO], selection: Int?) -> String? {
        if let s = selection, rows.indices.contains(s) { return rows[s].id }
        return rows.first?.id
    }

    static func unsortedText(_ count: Int) -> String? {
        guard count > 0 else { return nil }
        return count == 1 ? "1 unsorted window" : "\(count) unsorted windows"
    }

    /// The header state. The server problem wins: without the server nothing else works.
    static func health(serverProblem: String?, trusted: Bool,
                       startCommand: String = MenuStatus.cliStartCommand) -> Health {
        if let problem = serverProblem { return .problem(problem, fix: .command(startCommand)) }
        let lines = MenuStatus.lines(serverProblem: nil, trusted: trusted, contextCount: 1)
        if !trusted, let first = lines.first { return .problem(first, fix: .allowAccessibility) }
        return .ok
    }

    static func healthLabel(_ h: Health) -> String {
        h == .ok ? "Switchyard is running" : "Switchyard needs attention"
    }
}
