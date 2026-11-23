import AppKit
import ApplicationServices

/// AXUIElement wrapper that compares by element identity, so a window keeps its identity
/// across title and position changes.
struct ElementID: Hashable, @unchecked Sendable { // AXUIElement is an immutable, thread-safe CF handle
    let element: AXUIElement
    static func == (a: ElementID, b: ElementID) -> Bool { CFEqual(a.element, b.element) }
    func hash(into hasher: inout Hasher) { hasher.combine(CFHash(element)) }
}

/// Private but long-stable HIServices call (used by every macOS window manager): the CGWindowID behind an AX window.
@_silgen_name("_AXUIElementGetWindow")
private func _AXUIElementGetWindow(_ element: AXUIElement, _ out: UnsafeMutablePointer<CGWindowID>) -> AXError

enum AX {
    /// nil when the system will not say; callers fall back to a title-based key.
    static func windowNumber(_ el: AXUIElement) -> UInt32? {
        var id: CGWindowID = 0
        guard _AXUIElementGetWindow(el, &id) == .success, id != 0 else { return nil }
        return id
    }

    static func isTrusted(prompt: Bool) -> Bool {
        // Literal of kAXTrustedCheckOptionPrompt (the C global is awkward to use from Swift).
        let options = ["AXTrustedCheckOptionPrompt": prompt] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    /// How long one Accessibility call may wait for another app. The system default is 6 s, which a single
    /// hung app turns into a frozen switch.
    static let messagingTimeout: Float = 0.5
    /// Listing windows is done for every app on every refresh, so it gets less patience.
    static let listingTimeout: Float = 0.4

    /// Call once at launch: applies `messagingTimeout` to every element this process creates.
    static func configureTimeouts() {
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), messagingTimeout)
    }

    static func appElement(pid: pid_t) -> AXUIElement {
        let el = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(el, listingTimeout)
        return el
    }

    private static func copy(_ el: AXUIElement, _ attr: String) -> CFTypeRef? {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, attr as CFString, &ref) == .success else { return nil }
        return ref
    }

    static func string(_ el: AXUIElement, _ attr: String) -> String? {
        guard let ref = copy(el, attr) else { return nil }
        if let s = ref as? String { return s }
        if let u = ref as? URL { return u.absoluteString }
        return nil
    }

    /// The process that owns whatever is at this global (top-left) point on screen.
    static func pid(at point: CGPoint) -> pid_t? {
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &hit) == .success,
              let hit else { return nil }
        var pid: pid_t = 0
        return AXUIElementGetPid(hit, &pid) == .success ? pid : nil
    }

    static func element(_ el: AXUIElement, _ attr: String) -> AXUIElement? {
        guard let ref = copy(el, attr), CFGetTypeID(ref) == AXUIElementGetTypeID() else { return nil }
        return unsafeBitCast(ref, to: AXUIElement.self)
    }

    static func children(_ el: AXUIElement) -> [AXUIElement] {
        guard let ref = copy(el, kAXChildrenAttribute as String) else { return [] }
        return (ref as? [AXUIElement]) ?? []
    }

    static func windows(of app: AXUIElement) -> [AXUIElement] {
        guard let ref = copy(app, kAXWindowsAttribute as String) else { return [] }
        return (ref as? [AXUIElement]) ?? []
    }

    private static func axValue(_ el: AXUIElement, _ attr: String) -> AXValue? {
        guard let ref = copy(el, attr), CFGetTypeID(ref) == AXValueGetTypeID() else { return nil }
        return unsafeBitCast(ref, to: AXValue.self)
    }

    static func frame(_ el: AXUIElement) -> Rect? {
        var p = CGPoint.zero
        var s = CGSize.zero
        guard let pv = axValue(el, kAXPositionAttribute as String), AXValueGetValue(pv, .cgPoint, &p),
              let sv = axValue(el, kAXSizeAttribute as String), AXValueGetValue(sv, .cgSize, &s) else { return nil }
        return Rect(x: p.x, y: p.y, width: s.width, height: s.height)
    }

    @discardableResult
    static func setPosition(_ el: AXUIElement, x: Double, y: Double) -> Bool {
        var p = CGPoint(x: x, y: y)
        guard let v = AXValueCreate(.cgPoint, &p) else { return false }
        return AXUIElementSetAttributeValue(el, kAXPositionAttribute as CFString, v) == .success
    }

    @discardableResult
    static func setSize(_ el: AXUIElement, width: Double, height: Double) -> Bool {
        var s = CGSize(width: width, height: height)
        guard let v = AXValueCreate(.cgSize, &s) else { return false }
        return AXUIElementSetAttributeValue(el, kAXSizeAttribute as CFString, v) == .success
    }

    @discardableResult
    static func perform(_ el: AXUIElement, _ action: String) -> Bool {
        AXUIElementPerformAction(el, action as CFString) == .success
    }

    @discardableResult
    static func setBool(_ el: AXUIElement, _ attr: String, _ value: Bool) -> Bool {
        AXUIElementSetAttributeValue(el, attr as CFString, value as CFBoolean) == .success
    }
}

/// Screen frames in Accessibility coordinates. Call on the main thread.
@MainActor
func currentScreenFrames() -> [Rect] {
    let screens = NSScreen.screens
    guard let primary = screens.first else { return [] }
    let h = primary.frame.height
    return screens.map { s in
        let f = s.frame
        return FrameMath.fromCocoa(Rect(x: f.origin.x, y: f.origin.y, width: f.width, height: f.height), primaryHeight: h)
    }
}
