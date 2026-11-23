import AppKit
import ApplicationServices

/// Role and title of one Accessibility child, so the tab-bar reading below can be tested without a live app.
struct AXChild: Equatable {
    let role: String?
    let title: String?
}

/// Native tabs of terminal windows (Ghostty). Each tab is its own NSWindow; Accessibility shows only the selected
/// one, with the whole tab bar as an AXTabGroup child whose radio buttons are the tabs. Pure parts first.
enum TerminalTabs {
    static let bundleIds: Set<String> = ["com.mitchellh.ghostty"]
    static let moveTabItemTitle = "Move Tab to New Window"

    static func reads(bundleId: String) -> Bool { bundleIds.contains(bundleId) }

    /// Tab titles in bar order; empty for a single tab, which is just the window.
    static func titles(_ children: [AXChild]) -> [String] {
        let tabs = children.filter { $0.role == kAXRadioButtonRole as String }.map { $0.title ?? "" }
        return tabs.count > 1 ? tabs : []
    }

    /// The tab button for `ref`: at its index if the title still matches there, else the first with that title.
    static func buttonIndex(for ref: TabRefDTO, in titles: [String]) -> Int? {
        if titles.indices.contains(ref.index), titles[ref.index] == ref.title { return ref.index }
        return titles.firstIndex(of: ref.title)
    }

    /// Which tab bar to pull `title` from. A title in one bar only is found there. When several windows hold it
    /// (Claude Code names every tab after its topic), only the bar whose tabs are exactly the source window's counts;
    /// with no such bar the tab is not guessed, so a twin in another window is never moved.
    static func barIndex(holding title: String, in bars: [[String]], source: [String]) -> Int? {
        let holding = bars.indices.filter { bars[$0].contains(title) }
        if holding.count <= 1 { return holding.first }
        let own = holding.filter { bars[$0] == source }
        return own.count == 1 ? own[0] : nil
    }

    /// The source bar's tabs once `ref` has been pulled out of it.
    static func remaining(_ titles: [String], after ref: TabRefDTO) -> [String] {
        guard let index = buttonIndex(for: ref, in: titles) else { return titles }
        var rest = titles
        rest.remove(at: index)
        return rest
    }

    /// Rightmost first, so the tabs still to go keep their indexes.
    static func splitOrder(_ tabs: [TabRefDTO]) -> [TabRefDTO] { tabs.sorted { $0.index > $1.index } }

    static func isMoveTabItem(_ title: String?) -> Bool { title == moveTabItemTitle }

    // MARK: Accessibility

    /// The window's tab buttons, in bar order. Empty without a tab bar.
    static func buttons(of window: AXUIElement) -> [AXUIElement] {
        guard let group = AX.children(window).first(where: { AX.string($0, kAXRoleAttribute as String) == kAXTabGroupRole as String })
        else { return [] }
        return AX.children(group).filter { AX.string($0, kAXRoleAttribute as String) == kAXRadioButtonRole as String }
    }

    static func titles(of window: AXUIElement) -> [String] {
        titles(buttons(of: window).map { button in
            AXChild(role: kAXRadioButtonRole as String,
                    title: AX.string(button, kAXTitleAttribute as String) ?? AX.string(button, kAXDescriptionAttribute as String))
        })
    }

    /// "Window > Move Tab to New Window" of the app, wherever it sits in the menu bar.
    static func moveTabItem(pid: pid_t) -> AXUIElement? {
        guard let bar = AX.element(AXUIElementCreateApplication(pid), kAXMenuBarAttribute as String) else { return nil }
        for top in AX.children(bar) {
            for menu in AX.children(top) {
                if let item = AX.children(menu).first(where: { isMoveTabItem(AX.string($0, kAXTitleAttribute as String)) }) {
                    return item
                }
            }
        }
        return nil
    }
}
