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

/// Where a window lands when it moves to another display: centred, kept below the menu bar, never off the screen. Pure.
enum CrossDisplay {
    static let menuBarClearance = 30.0
    /// Points a window may exceed the room below the menu bar before it is shrunk.
    static let fitSlack = 8.0
    /// How long a moved window may take to show up on the other display's space.
    static let verifyTimeout: TimeInterval = 1.0

    static func position(window: Rect, screen: Rect) -> (x: Double, y: Double) {
        let f = frame(window: window, screen: screen)
        return (f.x, f.y)
    }

    /// Where a window lands on another display: shrunk to fit below the menu bar, then centred. A window bigger
    /// than the screen would hang over onto its old display, and macOS keeps it there (issue #14).
    static func frame(window: Rect, screen: Rect) -> Rect {
        let width = min(window.width, screen.width)
        let room = max(1, screen.height - menuBarClearance)
        // A maximized window (screen height minus a 24-25 pt menu bar) keeps its height.
        let height = window.height <= room + fitSlack ? window.height : room
        let x = screen.x + (screen.width - width) / 2
        let y = screen.y + max(menuBarClearance, (screen.height - height) / 2)
        return Rect(x: x, y: y, width: width, height: height)
    }

    /// The AX frame and the drawn (CGWindow) bounds agree, so the window really is where AX says.
    static func sameOrigin(_ a: Rect, _ b: Rect) -> Bool { abs(a.x - b.x) <= 2 && abs(a.y - b.y) <= 2 }

    /// True when the window has to shrink to fit.
    static func needsResize(window: Rect, screen: Rect) -> Bool {
        let f = frame(window: window, screen: screen)
        return f.width < window.width || f.height < window.height
    }
}
