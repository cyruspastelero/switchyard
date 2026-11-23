import AppKit
import Foundation

enum BrowserKind: String, CaseIterable {
    case chrome = "com.google.Chrome"
    case arc = "company.thebrowser.Browser"

    var supportsNaming: Bool { self == .chrome }

    /// Accepts a bundle id or a short name such as "chrome" or "Arc".
    static func parse(_ s: String) -> BrowserKind? {
        let l = s.lowercased()
        if let k = BrowserKind(rawValue: s) { return k }
        if l.contains("chrome") { return .chrome }
        if l.contains("arc") { return .arc }
        return nil
    }
}

struct BrowserWindow {
    let bundleId: String
    /// The process that listed it; nil when it was read by bundle id (Arc).
    let pid: pid_t?
    let id: String
    let name: String?
    let activeTitle: String?
    let bounds: Rect?
    let tabs: [BrowserTab]

    var info: BrowserWindowInfo { BrowserWindowInfo(id: id, name: name, activeTitle: activeTitle, bounds: bounds) }
}

enum BrowserError: Error, LocalizedError {
    case unsupported(String)
    case badURL(String)
    case badOutput

    var errorDescription: String? {
        switch self {
        case .unsupported(let m): return m
        case .badURL: return "URL scheme not allowed"
        case .badOutput: return "unexpected script output"
        }
    }
}

enum BrowserURL {
    static let allowedSchemes: Set<String> = ["http", "https", "file", "chrome", "about"]

    static func sanitize(_ s: String) -> String? {
        guard let u = URL(string: s), let scheme = u.scheme?.lowercased(), allowedSchemes.contains(scheme) else { return nil }
        return s
    }
}

struct BrowserLayer {
    /// Lists one browser process. A short timeout: a process that is busy, hung, or waiting on the
    /// Automation prompt gives up quickly. Called only by BrowserCache, in the background.
    func list(_ instance: BrowserInstance) async throws -> [BrowserWindow] {
        switch instance.kind {
        case .chrome:
            return try await ChromeBridge.list(pid: instance.pid, timeout: 4)
        case .arc:
            // AppleScript can't address a pid, so Arc is read by bundle id (it runs as a single process).
            let text = try await OSAScript.runFull(ArcScripts.list, args: [], timeout: 4, language: .appleScript)
            // Arc's window "name" is the Space name, not a name the owner gave the window: use it only for matching.
            return ArcScripts.parse(text).map { BrowserWindow(bundleId: instance.kind.rawValue, pid: nil, id: $0.id, name: nil,
                                                              activeTitle: $0.name, bounds: nil, tabs: $0.tabs) }
        }
    }

    private func requireWritable(_ kind: BrowserKind) throws {
        guard kind == .chrome else { throw BrowserError.unsupported("Arc can't be controlled by script; only reading tabs works") }
    }

    /// `pid`: the process that owns the window.
    func setName(_ kind: BrowserKind, pid: pid_t, windowId: String, name: String) async throws {
        guard kind.supportsNaming else { throw BrowserError.unsupported("Arc windows cannot be named") }
        try await ChromeBridge.setName(pid: pid, windowId: windowId, name: name)
    }

    func openWindow(_ kind: BrowserKind, pid: pid_t, name: String?, urls: [String]) async throws {
        try requireWritable(kind)
        let safe = try urls.map { u -> String in
            guard let s = BrowserURL.sanitize(u) else { throw BrowserError.badURL(u) }
            return s
        }
        try await ChromeBridge.openWindow(pid: pid, name: kind.supportsNaming ? name : nil, urls: safe)
    }

    func openTab(_ kind: BrowserKind, pid: pid_t, windowId: String, url: String) async throws {
        try requireWritable(kind)
        guard let safe = BrowserURL.sanitize(url) else { throw BrowserError.badURL(url) }
        try await ChromeBridge.openTab(pid: pid, windowId: windowId, url: safe)
    }

    func closeTab(_ kind: BrowserKind, pid: pid_t, windowId: String, tabId: String) async throws {
        try requireWritable(kind)
        try await ChromeBridge.closeTab(pid: pid, windowId: windowId, tabId: tabId)
    }

    func closeWindow(_ kind: BrowserKind, pid: pid_t, windowId: String) async throws {
        try requireWritable(kind)
        try await ChromeBridge.closeWindow(pid: pid, windowId: windowId)
    }
}
