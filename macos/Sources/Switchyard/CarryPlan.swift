import Foundation

// Pure parts of carrying windows between desktops: the order of work, the delays, the retry and the report.

/// The delays the carry spike proved on macOS 15.5 (18/18 carries, about 1.1 s each). See personal_docs/gotchas.md.
enum CarryDelays {
    static let afterRaise: TimeInterval = 0.15
    static let afterMoveToGrabPoint: TimeInterval = 0.05
    static let afterMouseDown: TimeInterval = 0.10
    static let betweenDragSteps: TimeInterval = 0.03
    static let dragStartTimeout: TimeInterval = 0.30
    static let betweenGrabTries: TimeInterval = 0.15
    static let switchPollInterval: TimeInterval = 0.02
    static let switchTimeout: TimeInterval = 1.5
    static let settleAfterSwitch: TimeInterval = 0.15
    static let beforeVerify: TimeInterval = 0.20
    static let afterHotKeyEnable: TimeInterval = 0.10
    static let betweenCarries: TimeInterval = 0.10
    static let buttonsUpWait: TimeInterval = 2.0
    /// A whole sort stops after this long; the rest is reported as left to sort.
    static let sortCap: TimeInterval = 45
    /// The retry multiplies every delay inside a carry (not the switch timeout).
    static let retryScale = 2.0
}

struct CarryMove: Equatable {
    let key: String
    let from: Int
    let to: Int
}

enum CarryStep: Equatable {
    case goTo(Int)
    case carry(String, to: Int)
}

struct CarryPlanResult: Equatable {
    let steps: [CarryStep]
    /// Moves past the cap, reported as left to sort.
    let leftOver: Int
}

enum CarryPlan {
    static let maxCarries = 30

    /// Greedy: after a drop on desktop T, a window waiting on T goes next, so no slide is wasted.
    /// Always ends on `start`, where the owner was.
    static func make(_ moves: [CarryMove], start: Int) -> CarryPlanResult {
        let needed = moves.filter { $0.from != $0.to }
        var pending = Array(needed.prefix(maxCarries))
        var steps: [CarryStep] = []
        var current = start
        while !pending.isEmpty {
            let index = pending.firstIndex { $0.from == current } ?? 0
            let move = pending.remove(at: index)
            if move.from != current { steps.append(.goTo(move.from)) }
            steps.append(.carry(move.key, to: move.to))
            current = move.to
        }
        if current != start { steps.append(.goTo(start)) }
        return CarryPlanResult(steps: steps, leftOver: needed.count - min(needed.count, maxCarries))
    }
}

enum CarryCheck {
    /// Moved means the window is on the target space and nowhere else.
    static func moved(spacesAfter: [UInt64], target: UInt64) -> Bool { spacesAfter == [target] }
}

enum CarryRetry {
    /// Runs the attempt at normal delays, then once more at doubled delays. Returns the attempt that worked.
    static func run(_ attempt: (_ scale: Double) throws -> Bool) rethrows -> Int? {
        for (index, scale) in [1.0, CarryDelays.retryScale].enumerated() {
            if try attempt(scale) { return index }
        }
        return nil
    }
}

enum CarryReport {
    /// The ack error and menu line, or nil when everything moved.
    static func summary(moved: Int, failed: [(key: String, reason: String)], leftOver: Int) -> String? {
        var parts: [String] = []
        if !failed.isEmpty {
            parts.append("could not move \(failed.count): " + failed.map { "\($0.key): \($0.reason)" }.joined(separator: "; "))
        }
        if leftOver > 0 { parts.append("\(leftOver) left to sort (limit reached)") }
        guard !parts.isEmpty else { return nil }
        return (["moved \(moved)"] + parts).joined(separator: ", ")
    }
}
