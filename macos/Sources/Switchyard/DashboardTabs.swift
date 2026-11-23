import AppKit
import Foundation

/// "Open dashboard" reuses a dashboard tab the owner already has in Chrome instead of opening another.
/// Arc is left out: its scripting can read tabs but not select or close them reliably.
enum DashboardTabs {
    struct Tab: Equatable {
        let pid: pid_t
        let windowId: String
        let tabId: String
        let url: String
    }

    /// The first dashboard tab to bring forward and the other dashboard tabs to close. A dashboard tab has the
    /// server's scheme and port on a loopback host (127.0.0.1 or localhost). Pure.
    static func plan(_ tabs: [Tab], server: URL) -> (keep: Tab?, close: [Tab]) {
        let matching = tabs.filter { isDashboard($0.url, server: server) }
        return (matching.first, Array(matching.dropFirst()))
    }

    static func isDashboard(_ raw: String, server: URL) -> Bool {
        guard let u = URL(string: raw), let host = u.host?.lowercased() else { return false }
        return ["127.0.0.1", "localhost"].contains(host) && u.scheme == server.scheme && u.port == server.port
    }

    /// Focuses an existing dashboard tab (closing duplicates), else opens the dashboard as before.
    static func open(_ server: URL) async {
        var tabs: [Tab] = []
        for app in NSRunningApplication.runningApplications(withBundleIdentifier: BrowserKind.chrome.rawValue) {
            let pid = app.processIdentifier
            // A Chrome that does not answer quickly (an automation Chrome) is skipped.
            guard let windows = try? await ChromeBridge.list(pid: pid, timeout: 2) else { continue }
            for w in windows { tabs += w.tabs.map { Tab(pid: pid, windowId: w.id, tabId: $0.id, url: $0.url) } }
        }
        let plan = plan(tabs, server: server)
        guard let keep = plan.keep else { await MainActor.run { _ = NSWorkspace.shared.open(server) }; return }
        for t in plan.close {
            do { try await ChromeBridge.closeTab(pid: t.pid, windowId: t.windowId, tabId: t.tabId) } catch {
                Log.browser.error("closing a duplicate dashboard tab failed: \(error.localizedDescription, privacy: .public)")
            }
        }
        do {
            try await ChromeBridge.focusTab(pid: keep.pid, windowId: keep.windowId, tabId: keep.tabId)
            await MainActor.run { _ = NSRunningApplication(processIdentifier: keep.pid)?.activate() }
        } catch {
            Log.browser.error("focusing the dashboard tab failed: \(error.localizedDescription, privacy: .public)")
            await MainActor.run { _ = NSWorkspace.shared.open(server) }
        }
    }
}
