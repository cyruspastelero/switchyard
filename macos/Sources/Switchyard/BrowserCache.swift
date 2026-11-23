import Foundation

enum BrowserBackoff {
    /// Seconds to wait before asking a browser again after `n` failures in a row: 15, 30, 60 ... capped at 5 minutes.
    static func delay(afterFailures n: Int) -> TimeInterval {
        guard n > 0 else { return 0 }
        return min(15 * pow(2, Double(min(n, 10) - 1)), 300)
    }
}

/// Last known browser windows. Reading never waits on a browser: scripts run in the background, and a browser
/// process that fails or hangs (for example on a pending Automation prompt) is asked less and less often.
/// Each process is asked on its own, so a hung one (an automation Chrome) never holds back the others.
/// Window snapshots and commands must never wait for it.
actor BrowserCache {
    private let layer = BrowserLayer()
    private var windows: [BrowserInstance: [BrowserWindow]] = [:]
    private var failures: [BrowserInstance: Int] = [:]
    private var retryAt: [BrowserInstance: Date] = [:]
    private var inFlight = Set<BrowserInstance>()

    /// Returns at once. Only running processes are asked (asking would launch the others).
    func current(running: [BrowserInstance]) -> [BrowserWindow] {
        let live = Set(running)
        for gone in Set(windows.keys).union(failures.keys).union(retryAt.keys) where !live.contains(gone) {
            windows[gone] = nil; failures[gone] = nil; retryAt[gone] = nil
        }
        for instance in BrowserInstances.due(running, inFlight: inFlight, retryAt: retryAt, now: Date()) {
            inFlight.insert(instance)
            Task { await self.load(instance) }
        }
        return running.flatMap { windows[$0] ?? [] }
    }

    /// pid -> window count, for each process that answered its last listing.
    func answering(_ kind: BrowserKind) -> [pid_t: Int] {
        var out: [pid_t: Int] = [:]
        for (instance, list) in windows where instance.kind == kind { out[instance.pid] = list.count }
        return out
    }

    private func load(_ instance: BrowserInstance) async {
        defer { inFlight.remove(instance) }
        let label = "\(instance.kind.rawValue) pid \(instance.pid)"
        do {
            windows[instance] = try await layer.list(instance)
            if failures[instance] != nil { Log.browser.notice("listing windows works again for \(label, privacy: .public)") }
            failures[instance] = nil; retryAt[instance] = nil
        } catch {
            let n = (failures[instance] ?? 0) + 1
            let wait = BrowserBackoff.delay(afterFailures: n)
            failures[instance] = n
            retryAt[instance] = Date().addingTimeInterval(wait)
            windows[instance] = nil // stale tabs would be sorted as if they were current
            // Log the first failure and each time the wait reaches its cap, not every attempt.
            if n == 1 || wait >= 300 {
                Log.browser.error("list windows failed for \(label, privacy: .public) (try \(n, privacy: .public), next in \(Int(wait), privacy: .public) s): \(error.localizedDescription, privacy: .public)")
            }
        }
    }
}
