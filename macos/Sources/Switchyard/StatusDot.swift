import AppKit

enum StatusDot {
    /// "#rrggbb" -> color; nil for anything else.
    static func rgb(hex: String?) -> (r: Double, g: Double, b: Double)? {
        guard var s = hex?.trimmingCharacters(in: .whitespaces) else { return nil }
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        return (Double((v >> 16) & 0xff) / 255, Double((v >> 8) & 0xff) / 255, Double(v & 0xff) / 255)
    }

    /// A colored circle. Non-template, so menus keep the color.
    static func image(hex: String?) -> NSImage {
        let c = rgb(hex: hex).map { NSColor(srgbRed: $0.r, green: $0.g, blue: $0.b, alpha: 1) } ?? NSColor.systemGray
        let img = NSImage(size: NSSize(width: 10, height: 10), flipped: false) { rect in
            c.setFill()
            NSBezierPath(ovalIn: rect.insetBy(dx: 1, dy: 1)).fill()
            return true
        }
        img.isTemplate = false
        return img
    }

    static func label(_ status: String) -> String {
        switch status {
        case "working": return "working"
        case "waiting": return "waiting on you"
        case "idle": return "idle"
        case "parked": return "parked"
        default: return status
        }
    }
}
