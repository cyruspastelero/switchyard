import Foundation

struct AXWindowInfo: Equatable {
    let index: Int
    let title: String
    let frame: Rect
}

struct BrowserWindowInfo: Equatable {
    let id: String
    let name: String?
    let activeTitle: String?
    let bounds: Rect?
}

enum WindowMatching {
    static let frameTolerance = 6.0

    /// Matches browser windows (AppleScript) to AX windows of the same app.
    /// Returns browser window id -> AX window index. Frames decide first; titles break ties
    /// and cover browser windows whose bounds are unavailable.
    static func match(ax: [AXWindowInfo], browser: [BrowserWindowInfo]) -> [String: Int] {
        var result: [String: Int] = [:]
        var used = Set<Int>()

        // Pass 1: exactly one frame candidate.
        for b in browser {
            let c = frameCandidates(for: b, in: ax, excluding: used)
            if c.count == 1 { result[b.id] = c[0].index; used.insert(c[0].index) }
        }
        // Pass 2: several frame candidates (same bounds) or none; use titles.
        for b in browser where result[b.id] == nil {
            var pool = frameCandidates(for: b, in: ax, excluding: used)
            if pool.isEmpty { pool = ax.filter { !used.contains($0.index) } }
            if let pick = pool.first(where: { titleMatches($0.title, b) }) {
                result[b.id] = pick.index; used.insert(pick.index)
            }
        }
        // Pass 3: one browser window and one AX window left over (e.g. Arc, which reports no bounds
        // and no active tab): they must be each other.
        let leftBrowser = browser.filter { result[$0.id] == nil && $0.bounds == nil }
        let leftAX = ax.filter { !used.contains($0.index) }
        if leftBrowser.count == 1, leftAX.count == 1 { result[leftBrowser[0].id] = leftAX[0].index }
        return result
    }

    static func titleMatches(_ axTitle: String, _ b: BrowserWindowInfo) -> Bool {
        let candidates = [b.name, b.activeTitle].compactMap { $0 }.filter { !$0.isEmpty }
        return candidates.contains { axTitle.contains($0) }
    }

    private static func frameCandidates(for b: BrowserWindowInfo, in ax: [AXWindowInfo], excluding used: Set<Int>) -> [AXWindowInfo] {
        guard let r = b.bounds else { return [] }
        return ax.filter { w in
            !used.contains(w.index)
                && abs(w.frame.x - r.x) <= frameTolerance && abs(w.frame.y - r.y) <= frameTolerance
                && abs(w.frame.width - r.width) <= frameTolerance && abs(w.frame.height - r.height) <= frameTolerance
        }
    }
}

enum WindowKeys {
    /// The key is the window server's number for the window (plus the owning pid), which stays the same while
    /// the window is open, whatever its title does and however often Switchyard restarts. Titles change all the
    /// time (a terminal running an agent retitles itself every second), so they are only the fallback.
    static func make(bundleId: String, pid: Int32, windowNumber: UInt32?, title: String, document: String?,
                     taken: Set<String>) -> String {
        if let n = windowNumber { return "\(bundleId)|w\(pid).\(n)" }
        let base = "\(bundleId)|\(title)|\(document ?? "")"
        guard taken.contains(base) else { return base }
        var n = 2
        while taken.contains("\(base)#\(n)") { n += 1 }
        return "\(base)#\(n)"
    }
}
