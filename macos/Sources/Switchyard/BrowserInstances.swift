import Foundation

/// One running process of a browser. Several can share a bundle id: the owner's Chrome next to an automation
/// Chrome started by a test tool. Apple Events go to one process, so every script names the process it means.
struct BrowserInstance: Hashable, Sendable {
    let kind: BrowserKind
    let pid: pid_t
}

/// An Accessibility window that may belong to a browser.
struct BrowserCandidate {
    let index: Int
    let bundleId: String
    let pid: pid_t
    let title: String
    let frame: Rect
}

enum BrowserInstances {
    /// Pairs browser windows with Accessibility windows of the same process. A window with no pid
    /// (read by bundle id, as Arc is) may pair with any process of its browser.
    static func pair(candidates: [BrowserCandidate], browser: [BrowserWindow]) -> [Int: BrowserWindow] {
        var out: [Int: BrowserWindow] = [:]
        let groups = Dictionary(grouping: browser) { GroupKey(bundleId: $0.bundleId, pid: $0.pid) }
        for (group, windows) in groups {
            let own = candidates.filter { $0.bundleId == group.bundleId && (group.pid == nil || $0.pid == group.pid) }
            let ax = own.map { AXWindowInfo(index: $0.index, title: $0.title, frame: $0.frame) }
            let matches = WindowMatching.match(ax: ax, browser: windows.map(\.info))
            for w in windows { if let idx = matches[w.id] { out[idx] = w } }
        }
        return out
    }

    /// The instances to ask now. One that is still answering an earlier request, or waiting out its
    /// backoff, is left alone; the others are asked regardless.
    static func due(_ instances: [BrowserInstance], inFlight: Set<BrowserInstance>,
                    retryAt: [BrowserInstance: Date], now: Date) -> [BrowserInstance] {
        instances.filter { !inFlight.contains($0) && (retryAt[$0] ?? .distantPast) <= now }
    }

    /// Where a new window opens: the answering instance with the most windows, else the newest process.
    /// `answering`: pid -> number of windows it listed last time.
    static func forNewWindow(running: [(pid: pid_t, launched: Date?)], answering: [pid_t: Int]) -> pid_t? {
        let live = running.filter { answering[$0.pid] != nil }
        if let best = live.max(by: { (answering[$0.pid] ?? 0) < (answering[$1.pid] ?? 0) }) { return best.pid }
        return running.max { ($0.launched ?? .distantPast) < ($1.launched ?? .distantPast) }?.pid
    }

    private struct GroupKey: Hashable {
        let bundleId: String
        let pid: pid_t?
    }
}
