import Foundation
import ScriptingBridge

/// Talks to one Chrome process through ScriptingBridge, addressed by pid. `tell application "Google Chrome"`
/// (osascript, by name or bundle id) can land on an automation Chrome that never answers; a pid cannot.
/// Values go in as typed properties and object ids, never into script text.
enum ChromeBridge {
    static func list(pid: pid_t, timeout: TimeInterval) async throws -> [BrowserWindow] {
        try await run(pid: pid, timeout: timeout) { s in
            let windows = try s.windows()
            let raw = try s.get(windows, "id")
            let ids = raw as? [Any] ?? []
            return try ids.map { raw in
                let id = "\(raw)"
                let w = try s.window(in: windows, id: id)
                return try s.read(w, id: id, pid: pid)
            }
        }
    }

    static func setName(pid: pid_t, windowId: String, name: String) async throws {
        try await run(pid: pid, timeout: commandTimeout) { s in
            let w = try s.window(in: try s.windows(), id: windowId)
            try s.set(w, name, "givenName")
        }
    }

    /// `urls` are already sanitized by the caller. The window and extra tabs are made with raw Apple Events
    /// (see ChromeEvents); the first URL and the name are set through ScriptingBridge, which can set by pid.
    static func openWindow(pid: pid_t, name: String?, urls: [String]) async throws {
        try await run(pid: pid, timeout: commandTimeout) { s in
            let windowId = try ChromeEvents.make(pid: pid, scriptingClass: ChromeEvents.windowClass, container: nil,
                                                 properties: [:], timeout: commandTimeout)
            // From here on the window exists: every error says so, so nobody retries into a second window blindly.
            let w = try afterWindowOpened("finding it") { try s.window(in: try s.windows(), id: windowId) }
            if let first = urls.first {
                try afterWindowOpened("loading the first URL") {
                    guard let tab = try s.get(w, "activeTab") as? SBObject else {
                        throw BrowserError.unsupported("the new window has no tab")
                    }
                    try s.set(tab, first, "URL")
                }
            }
            if urls.count > 1 {
                guard let container = ChromeEvents.windowSpecifier(id: windowId) else { throw BrowserError.unsupported("cannot address the new window") }
                let started = Date()
                for (index, url) in urls.enumerated().dropFirst() {
                    do {
                        if Date().timeIntervalSince(started) > commandTimeout * 2 { throw BrowserError.unsupported("Chrome is too slow") }
                        _ = try ChromeEvents.make(pid: pid, scriptingClass: ChromeEvents.tabClass, container: container,
                                                  properties: ["URL ": url], timeout: commandTimeout)
                    } catch {
                        throw BrowserError.unsupported("opened the window with \(index) of \(urls.count) tabs, then: \(error.localizedDescription)")
                    }
                }
            }
            if let name, !name.isEmpty { try afterWindowOpened("naming it") { try s.set(w, name, "givenName") } }
        }
    }

    /// Runs one step after the window was made, rewording its error to say the window exists.
    static func afterWindowOpened<T>(_ step: String, _ body: () throws -> T) throws -> T {
        do { return try body() } catch {
            throw BrowserError.unsupported("opened the window, but \(step) failed: \(error.localizedDescription)")
        }
    }

    /// The Key-Value Coding setter for a scripting key: "givenName" -> "setGivenName:", "URL" -> "setURL:".
    static func setterName(_ key: String) -> String {
        "set" + key.prefix(1).uppercased() + key.dropFirst() + ":"
    }

    static func openTab(pid: pid_t, windowId: String, url: String) async throws {
        try await run(pid: pid, timeout: commandTimeout) { s in
            _ = try s.window(in: try s.windows(), id: windowId) // the window must still exist
            guard let container = ChromeEvents.windowSpecifier(id: windowId) else { throw BrowserError.unsupported("cannot address the window") }
            _ = try ChromeEvents.make(pid: pid, scriptingClass: ChromeEvents.tabClass, container: container,
                                      properties: ["URL ": url], timeout: commandTimeout)
        }
    }

    static func closeTab(pid: pid_t, windowId: String, tabId: String) async throws {
        try await run(pid: pid, timeout: commandTimeout) { s in
            let w = try s.window(in: try s.windows(), id: windowId)
            guard let tabs = try s.get(w, "tabs") as? SBElementArray, let n = Int(tabId),
                  let tab = tabs.object(withID: n) as? SBObject else { throw BrowserError.unsupported("tab not found") }
            try s.close(tab)
        }
    }

    /// Makes the tab active and its window the front window of that Chrome.
    static func focusTab(pid: pid_t, windowId: String, tabId: String) async throws {
        try await run(pid: pid, timeout: commandTimeout) { s in
            let w = try s.window(in: try s.windows(), id: windowId)
            guard let tabs = try s.get(w, "tabs") as? SBElementArray,
                  let ids = try s.get(tabs, "id") as? [Any],
                  let index = ids.firstIndex(where: { "\($0)" == tabId }) else { throw BrowserError.unsupported("tab not found") }
            try s.set(w, index + 1, "activeTabIndex")
            try s.set(w, 1, "index")
        }
    }

    static func closeWindow(pid: pid_t, windowId: String) async throws {
        try await run(pid: pid, timeout: commandTimeout) { s in
            try s.close(try s.window(in: try s.windows(), id: windowId))
        }
    }

    private static let commandTimeout: TimeInterval = 12

    /// Every ScriptingBridge / Apple Event call goes through this one serial queue. On the shared concurrent queue a
    /// window listing overlapped another Chrome call and the app crashed with SIGSEGV inside AE (AEProcessMessage
    /// under AESendMessage): 5 crash reports on 2026-11-23, every one with 2+ threads in ScriptingBridge at once.
    private static let queue = DispatchQueue(label: "ph.pastelero.switchyard.chrome-bridge", qos: .utility)

    /// One queue for every pid, not one per pid: BrowserCache already keeps one listing per process, so the crashing
    /// overlaps were across processes (the owner's Chrome and an automation Chrome) or a listing plus a command.
    /// The cost: a hung Chrome holds the queue for up to one timeout per call (a listing stops at its first failed
    /// event, see Session.get), so other calls can wait about one timeout. The queue stays short: BrowserCache keeps one
    /// listing in flight per process and backs off from one that fails (15 s doubling to 5 min), DashboardTabs lists
    /// only when the dashboard is opened, and commands come from the owner's own clicks.
    /// ScriptingBridge calls block, so they run off the caller's thread, one at a time.
    private static func run<T>(pid: pid_t, timeout: TimeInterval, _ body: @escaping (Session) throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { cont in
            queue.async {
                cont.resume(with: Result {
                    guard let app = SBApplication(processIdentifier: pid) else { throw BrowserError.unsupported("Chrome pid \(pid) is not running") }
                    return try body(Session(app: app, timeout: timeout))
                })
            }
        }
    }

    /// One app reference plus the first Apple Event error it reported.
    private final class Session: NSObject, SBApplicationDelegate {
        let app: SBApplication
        private var error: Error?

        init(app: SBApplication, timeout: TimeInterval) {
            self.app = app
            super.init()
            app.timeout = Int(timeout * 60) // ticks
            app.delegate = self
        }

        func eventDidFail(_ event: UnsafePointer<AppleEvent>, withError error: Error) -> Any? {
            if self.error == nil { self.error = error }
            return nil
        }

        func check() throws {
            if let error { throw ChromeError(underlying: error) }
        }

        func windows() throws -> SBElementArray {
            // Without Chrome's dictionary (a process still starting, or not Chrome) the key is unknown and
            // value(forKey:) raises an Objective-C exception that Swift cannot catch: it took the app down.
            guard app.responds(to: NSSelectorFromString("windows")) else { throw BrowserError.unsupported("this process does not offer Chrome's scripting") }
            guard let w = app.value(forKey: "windows") as? SBElementArray else { try check(); throw BrowserError.unsupported("Chrome did not return its window list") }
            return w
        }

        func window(in windows: SBElementArray, id: String) throws -> SBObject {
            guard let n = Int(id), let w = windows.object(withID: n) as? SBObject else { throw BrowserError.unsupported("window \(id) not found in this Chrome") }
            return w
        }

        func close(_ object: SBObject) throws {
            let close = NSSelectorFromString("close")
            guard object.responds(to: close) else { throw BrowserError.unsupported("Chrome does not offer close") }
            _ = object.perform(close)
            try check()
        }

        /// Reads one property and stops at the first failed or timed-out event: checking only at the end let a stalled
        /// Chrome cost the full timeout for each of the ~7 events per window while the serial queue waited behind it.
        /// A key the object does not offer reads as nil: value(forKey:) would raise an exception Swift cannot catch.
        func get(_ object: SBObject, _ key: String) throws -> Any? {
            guard object.responds(to: NSSelectorFromString(key)) else { return nil }
            let value = object.value(forKey: key)
            try check()
            return value
        }

        /// One event for the whole array. Its elements come from an object that offered the array, so they carry
        /// Chrome's dictionary; SBElementArray itself has no per-key selector to check.
        func get(_ array: SBElementArray, _ key: String) throws -> Any? {
            let value = array.value(forKey: key)
            try check()
            return value
        }

        func set(_ object: SBObject, _ value: Any, _ key: String) throws {
            guard object.responds(to: NSSelectorFromString(ChromeBridge.setterName(key))) else {
                throw BrowserError.unsupported("Chrome does not offer setting \(key)")
            }
            object.setValue(value, forKey: key)
            try check()
        }

        func read(_ w: SBObject, id: String, pid: pid_t) throws -> BrowserWindow {
            let name = (try get(w, "givenName") as? String).flatMap { $0.isEmpty ? nil : $0 }
            let bounds = (try get(w, "bounds") as? NSValue).map { v -> Rect in
                let r = v.rectValue
                return Rect(x: Double(r.origin.x), y: Double(r.origin.y), width: Double(r.width), height: Double(r.height))
            }
            let activeTab = try get(w, "activeTab") as? SBObject
            let activeTitle = try activeTab.flatMap { try get($0, "title") as? String }
            var tabs: [BrowserTab] = []
            if let t = try get(w, "tabs") as? SBElementArray {
                let ids = try get(t, "id") as? [Any] ?? []
                let urls = try get(t, "URL") as? [Any] ?? []
                let titles = try get(t, "title") as? [Any] ?? []
                for (i, tabId) in ids.enumerated() {
                    tabs.append(BrowserTab(id: "\(tabId)", url: i < urls.count ? urls[i] as? String ?? "" : "",
                                           title: i < titles.count ? titles[i] as? String ?? "" : ""))
                }
            }
            return BrowserWindow(bundleId: BrowserKind.chrome.rawValue, pid: pid, id: id, name: name,
                                 activeTitle: activeTitle, bounds: bounds, tabs: tabs)
        }
    }
}

struct ChromeError: Error, LocalizedError {
    let underlying: Error
    var errorDescription: String? {
        (underlying as NSError).code == -1712 ? "Chrome did not answer in time" : "Chrome refused: \(underlying.localizedDescription)"
    }
}
