import ApplicationServices
import CoreGraphics
import Foundation

// Windows on other desktops, found without going there. `kAXWindows` lists only the current desktop's windows,
// so at launch every window elsewhere was missing until the owner visited its desktop.
// The window server lists them all (number, pid, desktop). Their Accessibility elements come from
// `_AXUIElementCreateWithRemoteToken`, trying element ids one by one: the approach AltTab ships, no SIP change.

@_silgen_name("_AXUIElementCreateWithRemoteToken")
private func _AXUIElementCreateWithRemoteToken(_ token: CFData) -> Unmanaged<AXUIElement>?

/// One window-server window, as `CGWindowListCopyWindowInfo` reports it (no title: that needs Screen Recording).
struct CGWindowInfo: Equatable {
    let number: UInt32
    let pid: Int32
    let layer: Int
    let bounds: Rect
}

enum RemoteWindows {
    /// Smaller than this is a helper surface, not a window someone works in.
    static let minSide = 50.0
    static let maxElementId: UInt64 = 1000
    /// Per app and refresh: the search stops after this long (a hung app must not hold the refresh).
    static let budget: TimeInterval = 0.1

    /// pid -> window numbers worth searching: normal-layer windows on another desktop that no listing has.
    static func missing(windows: [CGWindowInfo], desktopOf: [UInt32: Int], known: Set<UInt32>, livePids: Set<Int32>,
                        active: Int?) -> [Int32: [UInt32]] {
        guard let active else { return [:] }
        var result: [Int32: [UInt32]] = [:]
        for w in windows where w.layer == 0 && livePids.contains(w.pid) && !known.contains(w.number)
            && w.bounds.width >= minSide && w.bounds.height >= minSide {
            guard let d = desktopOf[w.number], d != active else { continue }
            result[w.pid, default: []].append(w.number)
        }
        return result
    }

    /// The 20-byte remote token: pid, 0, 'coco', element id (all little-endian).
    static func token(pid: Int32, elementId: UInt64) -> Data {
        var data = Data()
        withUnsafeBytes(of: pid.littleEndian) { data.append(contentsOf: $0) }
        withUnsafeBytes(of: Int32(0)) { data.append(contentsOf: $0) }
        withUnsafeBytes(of: Int32(0x636f636f).littleEndian) { data.append(contentsOf: $0) }
        withUnsafeBytes(of: elementId.littleEndian) { data.append(contentsOf: $0) }
        return data
    }

    /// Every normal-layer window the window server has, on all desktops.
    static func all() -> [CGWindowInfo] {
        let list = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        return list.compactMap { info in
            guard let n = (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
                  let pid = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
                  let layer = (info[kCGWindowLayer as String] as? NSNumber)?.intValue,
                  let dict = info[kCGWindowBounds as String] as? NSDictionary,
                  let r = CGRect(dictionaryRepresentation: dict) else { return nil }
            return CGWindowInfo(number: n, pid: pid, layer: layer, bounds: Rect(x: r.origin.x, y: r.origin.y, width: r.width, height: r.height))
        }
    }

    /// Window number -> element for the wanted windows of one app. Stops when all are found or the budget is spent.
    static func elements(pid: Int32, wanted: Set<UInt32>) -> [UInt32: AXUIElement] {
        var found: [UInt32: AXUIElement] = [:]
        let deadline = Date().addingTimeInterval(budget)
        for id in 0..<maxElementId {
            if found.count == wanted.count || Date() > deadline { break }
            guard let el = _AXUIElementCreateWithRemoteToken(token(pid: pid, elementId: id) as CFData)?.takeRetainedValue(),
                  let number = AX.windowNumber(el), wanted.contains(number), found[number] == nil,
                  AX.string(el, kAXRoleAttribute as String) == kAXWindowRole as String else { continue }
            found[number] = el
        }
        return found
    }
}

/// Window numbers whose search failed wait before the next try, so a window with no element costs nothing.
struct RemoteRetry {
    static let wait: TimeInterval = 60
    private var until: [UInt32: Date] = [:]

    func shouldTry(_ number: UInt32, now: Date) -> Bool { (until[number] ?? .distantPast) <= now }

    mutating func failed(_ numbers: [UInt32], at now: Date) {
        for n in numbers { until[n] = now.addingTimeInterval(Self.wait) }
    }

    mutating func keep(only alive: Set<UInt32>) { until = until.filter { alive.contains($0.key) } }
}
