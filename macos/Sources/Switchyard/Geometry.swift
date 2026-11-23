import Foundation

struct Rect: Codable, Equatable, Hashable {
    var x: Double
    var y: Double
    var width: Double
    var height: Double

    var maxX: Double { x + width }
    var maxY: Double { y + height }
    var centerX: Double { x + width / 2 }
    var centerY: Double { y + height / 2 }

    func contains(x px: Double, y py: Double) -> Bool {
        px >= x && px < maxX && py >= y && py < maxY
    }

    func intersects(_ o: Rect) -> Bool {
        x < o.maxX && maxX > o.x && y < o.maxY && maxY > o.y
    }
}

/// Pure frame math. All rects use Accessibility coordinates: origin top-left of the
/// primary screen, y grows downward.
enum FrameMath {
    /// Where a window's origin goes to hide it: the bottom-right corner of the screen,
    /// leaving 1 px visible (the AeroSpace technique).
    static func offscreenOrigin(for screen: Rect) -> (x: Double, y: Double) {
        (screen.maxX - 1, screen.maxY - 1)
    }

    /// The screen holding the frame's center, else the one it overlaps most, else the first.
    static func screen(containing frame: Rect, in screens: [Rect]) -> Rect? {
        if let hit = screens.first(where: { $0.contains(x: frame.centerX, y: frame.centerY) }) { return hit }
        let overlapping = screens.filter { $0.intersects(frame) }
        return overlapping.first ?? screens.first
    }

    /// Converts an AppKit frame (origin bottom-left of the primary screen) to Accessibility coordinates.
    static func fromCocoa(_ r: Rect, primaryHeight: Double) -> Rect {
        Rect(x: r.x, y: primaryHeight - r.maxY, width: r.width, height: r.height)
    }

    /// True when the origin sits at the parked position of some screen (within 2 px).
    static func isParked(origin: (x: Double, y: Double), screens: [Rect]) -> Bool {
        screens.contains { s in
            let p = offscreenOrigin(for: s)
            return abs(origin.x - p.x) <= 2 && abs(origin.y - p.y) <= 2
        }
    }

    /// The frame to restore to. A frame that no longer touches any screen (monitor unplugged)
    /// is moved onto the first screen.
    static func restorableFrame(_ saved: Rect, screens: [Rect]) -> Rect {
        guard let first = screens.first else { return saved }
        if screens.contains(where: { $0.intersects(saved) && !isParked(origin: (saved.x, saved.y), screens: [$0]) }) {
            return saved
        }
        return Rect(x: first.x + 40, y: first.y + 60, width: min(saved.width, first.width - 80), height: min(saved.height, first.height - 100))
    }

    /// A hidden window keeps its size, so putting it back is one move. Resize only when the frame had to change
    /// (monitor unplugged): a needless resize makes terminals snap and flicker.
    static func needsResize(saved: Rect, target: Rect) -> Bool {
        saved.width != target.width || saved.height != target.height
    }
}
