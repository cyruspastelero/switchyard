import CoreGraphics
import Foundation

// Where a carry grabs a window: proven by the carry spike (18/18 on 15.5). Pure.

enum CarryGrabError: Error, Equatable {
    case noTitleBar
    case outsideWindow
}

/// The places a mouse-down can start a window drag, in the order they are tried.
/// The edges use the standard macOS behaviour: dragging a resize edge along its length moves the window.
/// That is the only handle on a window with no title bar (Ghostty with `macos-titlebar-style = hidden`).
enum CarryGrabKind: String, CaseIterable, Equatable {
    case titleBar, leftEdge, rightEdge, topEdge, leftEdgeOption

    /// Ghostty's docs name Option + drag on a resize edge as the way to move a window with a hidden title bar.
    var holdsOption: Bool { self == .leftEdgeOption }
}

/// The grab that worked, per app, kept across launches: the first carry after a launch then skips the grabs
/// that fail for that app (Ghostty's title bar), which cost about 1.5 s.
struct CarryGrabMemory {
    static let key = "carryGrabKinds"
    var defaults = UserDefaults.standard

    func kind(for bundleId: String) -> CarryGrabKind? {
        (defaults.dictionary(forKey: Self.key)?[bundleId] as? String).flatMap(CarryGrabKind.init(rawValue:))
    }

    func remember(_ kind: CarryGrabKind, for bundleId: String) {
        var all = defaults.dictionary(forKey: Self.key) ?? [:]
        all[bundleId] = kind.rawValue
        defaults.set(all, forKey: Self.key)
    }
}

struct CarryGrabCandidate: Equatable {
    let kind: CarryGrabKind
    let point: CGPoint
    /// Unit direction of the test drag: along the title bar, or along the edge (down or right, never up into the menu bar).
    let dragX: Double
    let dragY: Double
}

enum CarryGrab {
    /// Amethyst's point: just right of the zoom button, a few px below the window's top edge.
    static let offsetRightOfZoomButton = 6.0
    static let offsetBelowTopEdge = 5.0
    /// How far inside the frame an edge grab sits. The resize band is a few px wide on both sides of the border.
    static let edgeInset = 1.0
    static let dragStep = 4.0
    static let dragSteps = 3

    /// Grab point in Accessibility (= CG global, top-left origin) coordinates. Never guesses without a zoom button.
    static func point(zoomButton: Rect?, window: Rect) -> Result<CGPoint, CarryGrabError> {
        guard let zoom = zoomButton, zoom.width > 0, zoom.height > 0 else { return .failure(.noTitleBar) }
        let x = zoom.maxX + offsetRightOfZoomButton
        let y = window.y + offsetBelowTopEdge
        guard x > window.x, x < window.maxX - 1, y < window.maxY - 1 else { return .failure(.outsideWindow) }
        return .success(CGPoint(x: x, y: y))
    }

    /// Every grab worth trying, `preferred` (the kind that worked for this window before) first.
    /// A point that is not on a screen is dropped, so a window parked off-screen has none.
    static func candidates(zoomButton: Rect?, window: Rect, screens: [Rect], preferred: CarryGrabKind?) -> [CarryGrabCandidate] {
        var all: [CarryGrabCandidate] = []
        if case .success(let point) = point(zoomButton: zoomButton, window: window) {
            all.append(CarryGrabCandidate(kind: .titleBar, point: point, dragX: 1, dragY: 0))
        }
        let left = CGPoint(x: window.x + edgeInset, y: window.centerY)
        let right = CGPoint(x: window.maxX - edgeInset - 1, y: window.centerY)
        let top = CGPoint(x: window.centerX, y: window.y + edgeInset)
        all.append(CarryGrabCandidate(kind: .leftEdge, point: left, dragX: 0, dragY: 1))
        all.append(CarryGrabCandidate(kind: .rightEdge, point: right, dragX: 0, dragY: 1))
        all.append(CarryGrabCandidate(kind: .topEdge, point: top, dragX: 1, dragY: 0))
        all.append(CarryGrabCandidate(kind: .leftEdgeOption, point: left, dragX: 0, dragY: 1))
        let onScreen = all.filter { c in screens.contains { $0.contains(x: c.point.x, y: c.point.y) } }
        return onScreen.filter { $0.kind == preferred } + onScreen.filter { $0.kind != preferred }
    }

    /// The test drag away from the grab point.
    static func dragOut(_ c: CarryGrabCandidate) -> [CGPoint] {
        (1...dragSteps).map { offset(c, by: Double($0) * dragStep) }
    }

    /// The way back, ending on the grab point so the window sits where it was.
    static func dragBack(_ c: CarryGrabCandidate) -> [CGPoint] {
        [offset(c, by: Double(dragSteps) * dragStep / 2), c.point]
    }

    /// A real window drag moves the window and keeps its size. A click on content moves nothing; a resize changes the size.
    static func dragStarted(before: Rect, after: Rect) -> Bool {
        let moved = abs(after.x - before.x) >= 1 || abs(after.y - before.y) >= 1
        let sameSize = abs(after.width - before.width) < 1 && abs(after.height - before.height) < 1
        return moved && sameSize
    }

    private static func offset(_ c: CarryGrabCandidate, by distance: Double) -> CGPoint {
        CGPoint(x: c.point.x + c.dragX * distance, y: c.point.y + c.dragY * distance)
    }
}
