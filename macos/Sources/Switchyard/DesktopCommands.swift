import AppKit
import ApplicationServices

/// What a `moveWindows` did, for the ack and the menu.
struct MoveResult {
    var moved = 0
    var failed: [(key: String, reason: String)] = []
    var leftOver = 0
    var aborted: String?
    var milliseconds = 0

    var ok: Bool { failed.isEmpty && leftOver == 0 && aborted == nil }

    var errorText: String? {
        let summary = CarryReport.summary(moved: moved, failed: failed, leftOver: leftOver)
        guard let aborted else { return summary }
        return (summary ?? "moved \(moved)") + ", \(aborted)"
    }
}

/// Desktop switches and carries. Every blocking step runs on its own thread, never on the main thread.
struct DesktopCommands {
    let windows: WindowLayer

    /// Goes to the desktop unless already there. Returns milliseconds taken.
    func goTo(_ number: Int) async throws -> Int {
        if Spaces.activeDesktopNumber() == number { return 0 } // no shortcut to turn on, no wait
        return try await Self.onThread {
            let lease = HotKeyLease.shared
            let keys = try lease.acquire([number])
            defer { lease.release() }
            return try DesktopSwitch.go(to: number, shortcuts: keys)
        }
    }

    /// Carries each window to its desktop, one at a time, then returns to the starting desktop.
    /// `progress(done, total)` is called on the main actor after each carry.
    func move(_ moves: [WindowMoveDTO], progress: @escaping @MainActor (Int, Int) -> Void) async -> MoveResult {
        var result = MoveResult()
        guard AX.isTrusted(prompt: false), CGPreflightPostEventAccess() else {
            result.failed = moves.map { ($0.windowKey, "Switchyard may not post mouse events (Accessibility)") }
            return result
        }
        var plannable: [CarryMove] = []
        var targets: [String: CarryTarget] = [:]
        for m in moves {
            guard let w = await windows.window(forKey: m.windowKey) else { result.failed.append((m.windowKey, "window not found")); continue }
            guard let from = w.desktop else {
                result.failed.append((m.windowKey, "window is not on a desktop (fullscreen, minimized or second display)")); continue
            }
            guard from != m.desktop else { continue }
            guard let target = await windows.carryTarget(forKey: m.windowKey) else {
                result.failed.append((m.windowKey, "window has no window number")); continue
            }
            targets[m.windowKey] = target
            plannable.append(CarryMove(key: m.windowKey, from: from, to: m.desktop))
        }
        guard let start = Spaces.activeDesktopNumber() else {
            result.failed += plannable.map { ($0.key, "the current space is not a desktop") }
            return result
        }
        let plan = CarryPlan.make(plannable, start: start)
        result.leftOver = plan.leftOver
        let fromOf = Dictionary(plannable.map { ($0.key, $0.from) }, uniquingKeysWith: { a, _ in a })
        let begin = Date()
        let run = await Self.onThreadResult { Self.execute(plan, start: start, fromOf: fromOf, targets: targets, progress: progress) }
        result.moved = run.moved
        result.failed += run.failed
        result.aborted = run.aborted
        result.leftOver += run.leftOver
        result.milliseconds = Int(Date().timeIntervalSince(begin) * 1000)
        let attempted = run.moved + run.failed.count
        if attempted >= 2 && run.moved == 0 {
            await windows.setCanCarry(false)
            Log.windows.error("every carry of this sort failed; falling back to off-screen hiding")
        }
        return result
    }

    /// Blocking. Before each carry the screen goes to the window's desktop, so one failure can't derail the rest.
    private static func execute(_ plan: CarryPlanResult, start: Int, fromOf: [String: Int], targets: [String: CarryTarget],
                                progress: @escaping @MainActor (Int, Int) -> Void) -> MoveResult {
        var result = MoveResult()
        let carries = plan.steps.compactMap { step -> (String, Int)? in
            if case .carry(let key, let to) = step { return (key, to) } else { return nil }
        }
        let numbers = Array(Set(carries.map(\.1) + carries.compactMap { fromOf[$0.0] } + [start]))
        let session = CarrySession()
        CarrySession.current = session
        let lease = HotKeyLease.shared
        defer {
            session.releaseMouse()
            lease.release()
            CarrySession.current = nil
        }
        let shortcuts: [Int: DesktopShortcut]
        do { shortcuts = try lease.acquire(numbers) } catch {
            result.failed = carries.map { ($0.0, error.localizedDescription) }
            return result
        }
        let carrier = WindowCarrier(session: session, shortcuts: shortcuts)
        if !carries.isEmpty { DispatchQueue.main.async { progress(0, carries.count) } }
        for (index, (key, to)) in carries.enumerated() {
            if session.timedOut { result.leftOver += carries.count - index; break }
            do {
                if index > 0 { try session.sleep(CarryDelays.betweenCarries) }
                guard let target = targets[key], let from = fromOf[key] else { throw CarryError.failed("window not found") }
                try DesktopSwitch.go(to: from, shortcuts: shortcuts, abort: session.check)
                try carrier.carry(target, to: to)
                result.moved += 1
            } catch CarryError.aborted(let why) {
                result.aborted = why
                result.leftOver += carries.count - index
                break
            } catch {
                result.failed.append((key, error.localizedDescription))
            }
            let done = index + 1
            DispatchQueue.main.async { progress(done, carries.count) }
        }
        session.releaseMouse()
        do { try DesktopSwitch.go(to: start, shortcuts: shortcuts) } catch {
            Log.windows.error("could not return to Desktop \(start, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }
        return result
    }

    private static func onThread<T>(_ work: @escaping () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            Thread { continuation.resume(with: Result { try work() }) }.start()
        }
    }

    private static func onThreadResult<T>(_ work: @escaping () -> T) async -> T {
        await withCheckedContinuation { continuation in
            Thread { continuation.resume(returning: work()) }.start()
        }
    }
}
