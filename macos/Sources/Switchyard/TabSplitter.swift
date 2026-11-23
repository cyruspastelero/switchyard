import AppKit
import ApplicationServices

/// Carries out `splitTabs`: each listed tab is selected and moved out with the app's own
/// "Move Tab to New Window" menu item. Nothing is ever closed.
struct TabSplitter {
    let windows: WindowLayer
    let desktops: DesktopCommands

    /// Pause after selecting a tab, and after pressing the menu item, for the app to redraw its windows.
    static let selectDelay: UInt64 = 250_000_000
    static let moveDelay: UInt64 = 400_000_000

    /// The titles of the tabs that could not be pulled out.
    func run(_ splits: [TabSplitDTO]) async -> [String] {
        var failed: [String] = []
        for split in splits {
            guard let w = await windows.window(forKey: split.windowKey) else {
                failed += split.tabs.map(\.title)
                continue
            }
            if let number = FocusPlan.desktopToVisit(window: w.desktop, active: Spaces.activeDesktopNumber()) {
                _ = try? await desktops.goTo(number)
            }
            // The source window's tab bar as last seen; it loses each tab pulled out of it.
            var source = w.tabTitles
            for tab in TerminalTabs.splitOrder(split.tabs) {
                if await pullOut(tab, pid: w.pid, source: source) {
                    source = TerminalTabs.remaining(source, after: tab)
                } else {
                    failed.append(tab.title)
                }
            }
        }
        return failed
    }

    private func pullOut(_ tab: TabRefDTO, pid: pid_t, source: [String]) async -> Bool {
        let before = Self.tabBarsHolding(tab.title, pid: pid)
        guard let bar = TerminalTabs.barIndex(holding: tab.title, in: before.map(\.2), source: source) else {
            Log.windows.notice("split: no tab bar, or no single source tab bar, holds the tab (\(before.count, privacy: .public) hold its title)")
            return false
        }
        let (window, buttons, titles) = before[bar]
        guard let index = TerminalTabs.buttonIndex(for: tab, in: titles) else { return false }
        await MainActor.run { _ = NSRunningApplication(processIdentifier: pid)?.activate() }
        AX.perform(window, kAXRaiseAction as String)
        AX.setBool(window, kAXMainAttribute as String, true)
        guard AX.perform(buttons[index], kAXPressAction as String) else {
            Log.windows.error("split: pressing the tab failed")
            return false
        }
        try? await Task.sleep(nanoseconds: Self.selectDelay)
        guard let item = TerminalTabs.moveTabItem(pid: pid), AX.perform(item, kAXPressAction as String) else {
            Log.windows.error("split: the Move Tab to New Window menu item was not found or not pressed")
            return false
        }
        try? await Task.sleep(nanoseconds: Self.moveDelay)
        let after = Self.tabBarsHolding(tab.title, pid: pid).count
        Log.windows.notice("split: tab bars holding the tab went \(before.count, privacy: .public) -> \(after, privacy: .public)")
        return after < before.count
    }

    /// Every tab bar of the app (one per window with two or more tabs) that has a tab with this title.
    private static func tabBarsHolding(_ title: String, pid: pid_t) -> [(AXUIElement, [AXUIElement], [String])] {
        AX.windows(of: AX.appElement(pid: pid)).compactMap { window in
            let buttons = TerminalTabs.buttons(of: window)
            let titles = TerminalTabs.titles(of: window)
            return titles.contains(title) && buttons.count == titles.count ? (window, buttons, titles) : nil
        }
    }
}
