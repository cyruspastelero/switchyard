import Foundation

/// Polls windows and browsers every 2 s. Sends the snapshot when its hash changes
/// (at most one send per poll) and at least every 5 s as a heartbeat.
final class SnapshotLoop: @unchecked Sendable {
    static let pollInterval: TimeInterval = 2
    static let heartbeat: TimeInterval = 5

    private let windows: WindowLayer
    private let api: APIClient
    private let lock = NSLock()
    private var nudged = false
    private var task: Task<Void, Never>?
    private var icons = IconUploads()

    init(windows: WindowLayer, api: APIClient) {
        self.windows = windows
        self.api = api
    }

    func start() {
        task = Task { [self] in await run() }
    }

    func stop() { task?.cancel() }

    /// Poll again soon (after a command changed something).
    func nudge() { lock.lock(); nudged = true; lock.unlock() }

    private func consumeNudge() -> Bool {
        lock.lock(); defer { lock.unlock() }
        let v = nudged; nudged = false; return v
    }

    private func run() async {
        var lastHash = ""
        var lastSent = Date.distantPast
        var failing = false
        while !Task.isCancelled {
            let wins = await windows.refresh()
            // Without the Accessibility grant there is nothing true to report; an empty snapshot would say "all windows closed".
            if AX.isTrusted(prompt: false) {
                let body = SnapshotBody(windows: wins.map(\.snapshot), desktops: await windows.desktops,
                                        canCarry: await windows.canCarry)
                let hash = body.fingerprint()
                let age = Date().timeIntervalSince(lastSent)
                if hash != lastHash || age >= Self.heartbeat {
                    do {
                        try await api.putSnapshot(body)
                        lastHash = hash; lastSent = Date()
                        await uploadIcons(wins)
                        if failing { Log.api.notice("snapshot sending recovered"); failing = false }
                    } catch is CancellationError {
                        return
                    } catch {
                        if !failing { Log.api.error("\(error.localizedDescription, privacy: .public)") }
                        failing = true
                    }
                }
            }
            await sleepUnlessNudged()
        }
    }

    /// Sends each app's icon once per launch. Only an unreachable server is tried again.
    private func uploadIcons(_ wins: [ManagedWindow]) async {
        let pidOf = Dictionary(wins.map { ($0.bundleId, $0.pid) }, uniquingKeysWith: { first, _ in first })
        for bundleId in icons.take(wins.map(\.bundleId)) {
            guard let pid = pidOf[bundleId], let png = await AppIcons.png(forPid: pid) else { continue }
            do {
                try await api.putIcon(bundleId: bundleId, png: png)
            } catch APIError.unreachable {
                icons.retry(bundleId)
            } catch {
                Log.api.error("icon for \(bundleId, privacy: .public): \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    private func sleepUnlessNudged() async {
        let slices = Int(Self.pollInterval / 0.25)
        for _ in 0..<slices {
            if Task.isCancelled || consumeNudge() { return }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
    }
}
