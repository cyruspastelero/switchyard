// Renders an SVG to a square PNG with AppKit's built-in SVG support (macOS 14+). No third-party tools.
// Usage: render-svg <input.svg> <output.png> <pixels>
import AppKit

let arguments = CommandLine.arguments
guard arguments.count == 4, let pixels = Int(arguments[3]), pixels > 0 else {
    FileHandle.standardError.write("usage: render-svg <input.svg> <output.png> <pixels>\n".data(using: .utf8)!)
    exit(2)
}
guard let image = NSImage(contentsOf: URL(fileURLWithPath: arguments[1])) else {
    FileHandle.standardError.write("render-svg: cannot read SVG \(arguments[1])\n".data(using: .utf8)!)
    exit(1)
}
guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4,
    hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
) else {
    FileHandle.standardError.write("render-svg: cannot allocate a \(pixels) px bitmap\n".data(using: .utf8)!)
    exit(1)
}
bitmap.size = NSSize(width: pixels, height: pixels)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
NSGraphicsContext.current?.imageInterpolation = .high
image.draw(in: NSRect(x: 0, y: 0, width: pixels, height: pixels))
NSGraphicsContext.restoreGraphicsState()
guard let png = bitmap.representation(using: .png, properties: [:]) else {
    FileHandle.standardError.write("render-svg: PNG encoding failed\n".data(using: .utf8)!)
    exit(1)
}
do {
    try png.write(to: URL(fileURLWithPath: arguments[2]))
} catch {
    FileHandle.standardError.write("render-svg: cannot write \(arguments[2]): \(error)\n".data(using: .utf8)!)
    exit(1)
}
