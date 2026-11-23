import Foundation
import ScriptingBridge

/// Talks to one Chrome process through ScriptingBridge, addressed by pid. `tell application "Google Chrome"`
/// (osascript, by name or bundle id) can land on an automation Chrome that never answers; a pid cannot.
/// Values go in as typed properties and object ids, never into script text.
enum ChromeBridge {
    static func list(pid: pid_t, timeout: TimeInterval) async throws -> [BrowserWindow] {
        try await run(pid: pid, timeout: timeout) { s in
            let windows = try s.windows()
            let raw: Any? = windows.value(forKey: "id")
            try s.check()
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
            w.setValue(name, forKey: "givenName")
            try s.check()
        }
    }

    /// `urls` are already sanitized by the caller. The window and extra tabs are made with raw Apple Events
    /// (see ChromeEvents); the first URL and the name are set through ScriptingBridge, which can set by pid.
    static func openWindow(pid: pid_t, name: String?, urls: [String]) async throws {
        try await run(pid: pid, timeout: commandTimeout) { s in
            let windowId = try ChromeEvents.make(pid: pid, scriptingClass: ChromeEvents.windowClass, container: nil,
                                                 properties: [:], timeout: commandTimeout)
            let w = try s.window(in: try s.windows(), id: windowId)
            if let first = urls.first {
                guard let tab = w.value(forKey: "activeTab") as? SBObject else {
                    try s.check(); throw BrowserError.unsupported("the new window has no tab to load the first URL")
                }
                tab.setValue(first, forKey: "URL")
                try s.check()
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
                        // The window exists with `index` tabs: say so, so nobody retries into a second window blindly.
                        throw BrowserError.unsupported("opened the window with \(index) of \(urls.count) tabs, then: \(error.localizedDescription)")
                    }
                }
            }
            if let name, !name.isEmpty { w.setValue(name, forKey: "givenName"); try s.check() }
        }
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
            guard let tabs = w.value(forKey: "tabs") as? SBElementArray, let n = Int(tabId),
                  let tab = tabs.object(withID: n) as? SBObject else { throw BrowserError.unsupported("tab not found") }
            try s.close(tab)
        }
    }

    /// Makes the tab active and its window the front window of that Chrome.
    static func focusTab(pid: pid_t, windowId: String, tabId: String) async throws {
        try await run(pid: pid, timeout: commandTimeout) { s in
            let w = try s.window(in: try s.windows(), id: windowId)
            guard let tabs = w.value(forKey: "tabs") as? SBElementArray,
                  let ids = tabs.value(forKey: "id") as? [Any],
                  let index = ids.firstIndex(where: { "\($0)" == tabId }) else { throw BrowserError.unsupported("tab not found") }
            w.setValue(index + 1, forKey: "activeTabIndex")
            w.setValue(1, forKey: "index")
            try s.check()
        }
    }

    static func closeWindow(pid: pid_t, windowId: String) async throws {
        try await run(pid: pid, timeout: commandTimeout) { s in
            try s.close(try s.window(in: try s.windows(), id: windowId))
        }
    }

    private static let commandTimeout: TimeInterval = 12

    /// ScriptingBridge calls block, so they run off the caller's thread.
    private static func run<T>(pid: pid_t, timeout: TimeInterval, _ body: @escaping (Session) throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { cont in
            DispatchQueue.global(qos: .utility).async {
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

        func read(_ w: SBObject, id: String, pid: pid_t) throws -> BrowserWindow {
            let name = (w.value(forKey: "givenName") as? String).flatMap { $0.isEmpty ? nil : $0 }
            let bounds = (w.value(forKey: "bounds") as? NSValue).map { v -> Rect in
                let r = v.rectValue
                return Rect(x: Double(r.origin.x), y: Double(r.origin.y), width: Double(r.width), height: Double(r.height))
            }
            let activeTitle = (w.value(forKey: "activeTab") as? SBObject)?.value(forKey: "title") as? String
            var tabs: [BrowserTab] = []
            if let t = w.value(forKey: "tabs") as? SBElementArray {
                let ids = t.value(forKey: "id") as? [Any] ?? []
                let urls = t.value(forKey: "URL") as? [Any] ?? []
                let titles = t.value(forKey: "title") as? [Any] ?? []
                for (i, tabId) in ids.enumerated() {
                    tabs.append(BrowserTab(id: "\(tabId)", url: i < urls.count ? urls[i] as? String ?? "" : "",
                                           title: i < titles.count ? titles[i] as? String ?? "" : ""))
                }
            }
            try check()
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
