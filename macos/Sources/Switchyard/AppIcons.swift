import AppKit
import Foundation

/// App icons for the dashboard: a small PNG per bundle id, uploaded once per launch.
enum AppIcons {
    static let maxBytes = 16_384

    /// 64×64 pixels (a 32-point icon on a retina screen); 32×32 when that would be over the size cap.
    static func png(from image: NSImage) -> Data? {
        for pixels in [64, 32] {
            if let data = render(image, pixels: pixels), data.count <= maxBytes { return data }
        }
        return nil
    }

    /// The icon macOS shows for the app that owns `pid`.
    @MainActor
    static func png(forPid pid: pid_t) -> Data? {
        guard let url = NSRunningApplication(processIdentifier: pid)?.bundleURL else { return nil }
        return png(from: NSWorkspace.shared.icon(forFile: url.path))
    }

    private static func render(_ image: NSImage, pixels: Int) -> Data? {
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8,
                                         samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                         bytesPerRow: 0, bitsPerPixel: 0),
              let context = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        context.imageInterpolation = .high
        image.draw(in: NSRect(x: 0, y: 0, width: pixels, height: pixels), from: .zero, operation: .copy, fraction: 1)
        NSGraphicsContext.restoreGraphicsState()
        return rep.representation(using: .png, properties: [:])
    }
}

/// Which bundle ids still need their icon sent. Each goes once per launch unless the send could not reach the server.
struct IconUploads {
    private var taken: Set<String> = []

    mutating func take(_ bundleIds: [String]) -> [String] {
        var out: [String] = []
        for id in bundleIds where !taken.contains(id) {
            taken.insert(id)
            out.append(id)
        }
        return out
    }

    mutating func retry(_ bundleId: String) { taken.remove(bundleId) }
}

/// What a `focusWindow` does before raising: go to the window's desktop when it is on another one.
enum FocusPlan {
    static func desktopToVisit(window: Int?, active: Int?) -> Int? {
        guard let window, window != active else { return nil }
        return window
    }
}
