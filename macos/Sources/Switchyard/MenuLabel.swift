import AppKit
import SwiftUI

/// The menu bar item: the Switchyard mark, with the number of contexts waiting on the owner.
struct MenuLabel: View {
    @ObservedObject var model: AppModel

    var body: some View {
        let healthy = model.serverProblem == nil && model.trusted
        let title = Self.title(contexts: model.contexts, activeContextId: model.activeContextId)
        HStack(spacing: 3) {
            Image(nsImage: SwitchyardMark.image(healthy: healthy))
            if let title { Text(title) }
            if model.waitingCount > 0 { Text(title == nil ? "\(model.waitingCount)" : "· \(model.waitingCount)") }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Self.accessibilityText(healthy: healthy, waiting: model.waitingCount, context: title))
    }

    static let maxTitle = 18

    /// The current context's name, short enough for a crowded menu bar.
    static func title(contexts: [ContextDTO], activeContextId: String?) -> String? {
        guard let id = activeContextId, let c = contexts.first(where: { $0.id == id }) else { return nil }
        return HUDText.cut(c.name, to: maxTitle)
    }

    static func accessibilityText(healthy: Bool, waiting: Int, context: String? = nil) -> String {
        var parts = ["Switchyard"]
        if let context { parts.append(context) }
        if !healthy { parts.append("needs attention") }
        if waiting > 0 { parts.append("\(waiting) waiting") }
        return parts.joined(separator: ", ")
    }
}

/// The Switchyard mark as a monochrome template image: one track runs straight and a second
/// switches off it to the right. Same shape as macos/Resources/MenuBarIcon.svg (18 pt grid, y down).
/// Drawn in code so it needs no bundle resource; strokes sit on whole points so 1x stays crisp.
@MainActor
enum SwitchyardMark {
    static let size = NSSize(width: 18, height: 18)
    private static let healthyImage = make(dimmed: false)
    private static let unhealthyImage = make(dimmed: true)

    static func image(healthy: Bool) -> NSImage {
        healthy ? healthyImage : unhealthyImage
    }

    private static func make(dimmed: Bool) -> NSImage {
        let image = NSImage(size: size, flipped: true) { _ in
            // Template images keep alpha, so a faint mark reads as dimmed in either menu bar theme.
            // One transparency layer, so the two strokes do not double up where they overlap.
            let context = NSGraphicsContext.current?.cgContext
            context?.setAlpha(dimmed ? 0.4 : 1)
            context?.beginTransparencyLayer(auxiliaryInfo: nil)
            NSColor.black.setStroke()
            let main = NSBezierPath()
            main.move(to: NSPoint(x: 6, y: 16))
            main.line(to: NSPoint(x: 6, y: 2))
            let branch = NSBezierPath()
            branch.move(to: NSPoint(x: 6, y: 13))
            branch.curve(to: NSPoint(x: 13, y: 5.5),
                         controlPoint1: NSPoint(x: 6, y: 9),
                         controlPoint2: NSPoint(x: 13, y: 9.5))
            branch.line(to: NSPoint(x: 13, y: 2))
            for path in [main, branch] {
                path.lineWidth = 2
                path.lineCapStyle = .round
                path.lineJoinStyle = .round
                path.stroke()
            }
            context?.endTransparencyLayer()
            context?.setAlpha(1)
            if dimmed { drawProblemDot() }
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = dimmed ? "Switchyard, needs attention" : "Switchyard"
        return image
    }

    /// A solid dot in the empty lower-right corner: a slash through the mark is unreadable at 16 px.
    private static func drawProblemDot() {
        NSColor.black.setFill()
        NSBezierPath(ovalIn: NSRect(x: 11.5, y: 11.5, width: 6, height: 6)).fill()
    }
}
