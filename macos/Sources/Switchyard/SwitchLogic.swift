import Foundation

// Pure decisions behind a fast switch. No AppKit, so all of it is tested.

struct LocalSwitchPlan: Equatable {
    let sets: ShowSets
    /// Target windows, front first.
    let order: [String]
    /// Real desktops: go here first. nil in off-screen mode.
    let desktop: Int?
    /// Target windows known to sit on another desktop: never raised, so the screen cannot follow them back.
    var strays: [String] = []
}

/// A switch worked out from the contexts the app already holds, so a hotkey does not wait for the server.
/// The server is told afterwards and its own `show` then only corrects what this got wrong.
enum LocalSwitch {
    /// nil when the app cannot decide alone (unknown or parked context): the server answers those.
    static func plan(contexts: [ContextDTO], target: String) -> LocalSwitchPlan? {
        guard let context = contexts.first(where: { $0.id == target }), context.status != "parked" else { return nil }
        // A window whose desktop is unknown goes through; the window layer checks it again just before raising.
        let isStray: (WindowRef) -> Bool = { w in
            guard let target = context.desktop, let d = w.desktop else { return false }
            return d != target
        }
        let order = context.windows.filter { !isStray($0) }.map(\.key)
        let strays = context.windows.filter(isStray).map(\.key)
        // With real desktops only contexts on the same desktop are hidden; the server adds windows it could not carry.
        let others = contexts.filter { $0.id != target && (context.desktop == nil || $0.desktop == context.desktop) }
        let hide = others.flatMap { $0.windows.map(\.key) }
        return LocalSwitchPlan(sets: ShowSets(shown: Set(order), hide: Set(hide)), order: order, desktop: context.desktop,
                               strays: strays)
    }
}

/// Raising or activating a window on another desktop makes macOS follow it there: the switch bounces back.
enum RaiseFilter {
    /// Keys of the windows on `active`, in order. With no active desktop (off-screen mode) everything is kept.
    static func onDesktop(_ targets: [(key: String, desktop: Int?)], active: Int?) -> [String] {
        guard let active else { return targets.map(\.key) }
        return targets.filter { $0.desktop == active }.map(\.key)
    }
}

/// After a switch: did the screen stay on the target desktop?
enum ShowBounce: Equatable {
    case ok, goBack, giveUp

    static let checkDelay: TimeInterval = 0.3

    /// `landed` nil: a fullscreen space or another display, which a raise did not cause.
    static func decide(target: Int, landed: Int?, alreadyCorrected: Bool) -> ShowBounce {
        guard let landed, landed != target else { return .ok }
        return alreadyCorrected ? .giveUp : .goBack
    }
}

/// The context's windows the server says sit on another desktop than the context's own.
enum ContextStrays {
    static func desktops(_ c: ContextDTO) -> [Int] {
        guard let target = c.desktop else { return [] }
        return c.windows.compactMap(\.desktop).filter { $0 != target }
    }
}

struct RaiseTarget: Equatable {
    let key: String
    let pid: Int32
}

enum RaiseStep: Equatable {
    case raise(String)
    case activate(Int32)
}

enum RaisePlan {
    /// Back to front, so the first target ends on top. An app is activated once per run of its windows
    /// (right after the run's first raise), not once per window: every extra activation is a menu-bar flash.
    static func steps(_ frontToBack: [RaiseTarget]) -> [RaiseStep] {
        var steps: [RaiseStep] = []
        var activePid: Int32?
        for target in frontToBack.reversed() {
            steps.append(.raise(target.key))
            if activePid != target.pid {
                steps.append(.activate(target.pid))
                activePid = target.pid
            }
        }
        return steps
    }
}

enum ShowDecision: Equatable {
    /// Apply the command's show and hide sets, raising only these windows (front first).
    case apply(raise: [String])
    /// The command belongs to a switch the owner has already left.
    case skip
}

/// Recognises the server's `show` that follows a local switch, so windows are not raised (and flashed) twice.
struct ShowEcho {
    static let window: TimeInterval = 5

    private struct Local {
        let contextId: String
        let raised: Set<String>
        let at: Date
    }

    private var locals: [Local] = []

    mutating func recordLocal(contextId: String, raised: Set<String>, at: Date) {
        locals.append(Local(contextId: contextId, raised: raised, at: at))
    }

    mutating func decide(contextId: String?, focus: Bool, windowKeys: [String], now: Date) -> ShowDecision {
        locals.removeAll { now.timeIntervalSince($0.at) > Self.window }
        guard focus else { return .apply(raise: []) }
        guard let contextId, let index = locals.firstIndex(where: { $0.contextId == contextId }) else {
            return .apply(raise: windowKeys)
        }
        let local = locals.remove(at: index)
        // A newer local switch went somewhere else: applying this one would flip the screen back and forth.
        if let newest = locals.last, newest.at > local.at, newest.contextId != contextId { return .skip }
        return .apply(raise: windowKeys.filter { !local.raised.contains($0) })
    }
}

/// Apps that take too long to list their windows. One such app used to hold every refresh, and so every
/// switch, for the full Accessibility timeout. They are asked again less and less often.
struct SlowApps {
    static let threshold: TimeInterval = 0.2

    private var failures: [Int32: Int] = [:]
    private var retryAt: [Int32: Date] = [:]

    static func delay(afterFailures n: Int) -> TimeInterval {
        guard n > 0 else { return 0 }
        return min(30 * pow(2, Double(min(n, 10) - 1)), 300)
    }

    func shouldSkip(_ pid: Int32, now: Date) -> Bool {
        (retryAt[pid] ?? .distantPast) > now
    }

    func isSlow(_ pid: Int32) -> Bool { failures[pid] != nil }

    /// Returns how long the app will be skipped, or nil when it answered in time.
    @discardableResult
    mutating func record(pid: Int32, seconds: TimeInterval, now: Date) -> TimeInterval? {
        guard seconds >= Self.threshold else {
            failures[pid] = nil; retryAt[pid] = nil
            return nil
        }
        let n = (failures[pid] ?? 0) + 1
        let wait = Self.delay(afterFailures: n)
        failures[pid] = n
        retryAt[pid] = now.addingTimeInterval(wait)
        return wait
    }

    mutating func keep(only pids: Set<Int32>) {
        failures = failures.filter { pids.contains($0.key) }
        retryAt = retryAt.filter { pids.contains($0.key) }
    }
}

/// Window moves are quick and must never queue behind browser scripts, which can take seconds.
enum CommandLane: Equatable {
    case windows
    case slow

    static func of(_ type: String) -> CommandLane {
        ["show", "showAll", "moveWindows", "focusWindow", "tidy", "undoTidy", "captureLayout"].contains(type) ? .windows : .slow
    }
}
