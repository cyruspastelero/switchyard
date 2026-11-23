import AppKit
import ApplicationServices

// Carries a window to another desktop: hold its title bar (or an edge), press Ctrl+N, let go.
// The only way that works with SIP on. Ported from the carry spike, which passed 18/18 on macOS 15.5.

enum CarryError: Error, LocalizedError {
    case aborted(String)
    case failed(String)

    var errorDescription: String? {
        switch self {
        case .aborted(let why): return "stopped: \(why)"
        case .failed(let why): return why
        }
    }
}

/// One window to carry. Never holds or logs the title.
struct CarryTarget {
    let key: String
    let pid: pid_t
    let bundleId: String
    let element: AXUIElement
    let windowId: UInt32
}

/// State that cleanup must undo from any thread: the held mouse button and the moved pointer.
/// `current` lets quit and SIGTERM let go of a window mid-carry.
final class CarrySession: @unchecked Sendable {
    static var current: CarrySession?
    static let escapeKeyCode: CGKeyCode = 53

    let deadline: Date
    private let lock = NSLock()
    private var abortReason: String?
    private var mouseDownAt: CGPoint?
    private var mouseFlags: CGEventFlags = []
    private var savedPointer: CGPoint?
    private let source = CGEventSource(stateID: .hidSystemState)

    init(cap: TimeInterval = CarryDelays.sortCap) { deadline = Date().addingTimeInterval(cap) }

    func abort(_ reason: String) {
        lock.lock(); defer { lock.unlock() }
        if abortReason == nil { abortReason = reason }
    }

    var isAborted: Bool { lock.lock(); defer { lock.unlock() }; return abortReason != nil }
    var timedOut: Bool { Date() > deadline }

    /// Throws when the owner pressed Escape or the session was stopped.
    func check() throws {
        if CGEventSource.keyState(.hidSystemState, key: Self.escapeKeyCode) { abort("Escape pressed") }
        lock.lock(); let reason = abortReason; lock.unlock()
        if let reason { throw CarryError.aborted(reason) }
    }

    /// Sleeps in short slices so an abort is seen quickly.
    func sleep(_ seconds: TimeInterval) throws {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            try check()
            usleep(useconds_t(min(0.01, max(0, end.timeIntervalSinceNow)) * 1_000_000))
        }
        try check()
    }

    static func grabKind(for bundleId: String) -> CarryGrabKind? { CarryGrabMemory().kind(for: bundleId) }

    static func remember(_ kind: CarryGrabKind, for bundleId: String) { CarryGrabMemory().remember(kind, for: bundleId) }

    // MARK: Events

    static var anyButtonDown: Bool {
        [CGMouseButton.left, .right, .center].contains { CGEventSource.buttonState(.hidSystemState, button: $0) }
    }

    static var pointer: CGPoint { CGEvent(source: nil)?.location ?? .zero }

    func post(_ type: CGEventType, at point: CGPoint, flags: CGEventFlags) {
        guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: .left) else { return }
        if type == .leftMouseDown || type == .leftMouseUp || type == .leftMouseDragged {
            event.setIntegerValueField(.mouseEventClickState, value: 1)
        }
        event.flags = flags
        event.post(tap: .cghidEventTap)
    }

    func savePointer(_ saved: CGPoint) { lock.lock(); savedPointer = saved; lock.unlock() }

    func mouseDown(at point: CGPoint, flags: CGEventFlags) {
        lock.lock(); mouseDownAt = point; mouseFlags = flags; lock.unlock()
        post(.leftMouseDown, at: point, flags: flags)
    }

    func drag(to point: CGPoint) {
        lock.lock(); mouseDownAt = point; let flags = mouseFlags; lock.unlock()
        post(.leftMouseDragged, at: point, flags: flags)
    }

    /// Mouse-up where the drag ended, then the pointer back where the owner left it. Safe to call twice.
    func releaseMouse() {
        lock.lock()
        let down = mouseDownAt, saved = savedPointer, flags = mouseFlags
        mouseDownAt = nil; savedPointer = nil; mouseFlags = []
        lock.unlock()
        if let down { post(.leftMouseUp, at: down, flags: flags) }
        if let saved {
            CGWarpMouseCursorPosition(saved)
            CGAssociateMouseAndMouseCursorPosition(1)
        }
    }
}

/// Carries one window from the active desktop to another, with one retry at doubled delays.
struct WindowCarrier {
    let session: CarrySession
    let shortcuts: [Int: DesktopShortcut]

    func carry(_ window: CarryTarget, to number: Int) throws {
        let desktops = Spaces.desktops()
        guard let target = desktops.first(where: { $0.number == number }) else { throw CarryError.failed("Desktop \(number) does not exist") }
        guard let key = shortcuts[number] else { throw CarryError.failed("no shortcut for Desktop \(number)") }
        let spaces = Spaces.spaces(ofWindow: window.windowId)
        guard spaces.count == 1, let from = desktops.first(where: { $0.id == spaces[0] }) else {
            throw CarryError.failed("window is not on one desktop")
        }
        let home = from.id
        try waitForButtonsUp()
        try checkCarryable(window, on: home)
        if from.displayId != target.displayId { return try moveAcross(window, to: target, key: key) }
        let worked = try CarryRetry.run { scale in
            if scale > 1 {
                Log.windows.notice("window \(window.windowId, privacy: .public) did not move; retrying with doubled delays")
                try goBack(to: home, window: window)
            }
            return try attempt(window, to: target, key: key, scale: scale)
        }
        guard worked != nil else { throw CarryError.failed("window did not move after a retry") }
    }

    private func waitForButtonsUp() throws {
        let end = Date().addingTimeInterval(CarryDelays.buttonsUpWait)
        while CarrySession.anyButtonDown && Date() < end { try session.sleep(0.02) }
        if CarrySession.anyButtonDown { throw CarryError.failed("a mouse button was held down") }
    }

    private func checkCarryable(_ window: CarryTarget, on space: UInt64) throws {
        if AXBool.read(window.element, kAXMinimizedAttribute as String) == true { throw CarryError.failed("window is minimized") }
        if AXBool.read(window.element, "AXFullScreen") == true { throw CarryError.failed("window is fullscreen") }
        guard Spaces.isShowing(space) else { throw CarryError.failed("window is not on the current desktop") }
    }

    /// Another display: dragging while that display switches leaves the window behind. Show the target desktop
    /// there, then move the window onto that screen; a window takes the space its display shows.
    private func moveAcross(_ window: CarryTarget, to target: Desktop, key: DesktopShortcut) throws {
        DesktopKeys.post(key)
        try DesktopSwitch.wait(for: target.id, number: target.number, abort: session.check)
        try session.sleep(CarryDelays.settleAfterSwitch)
        guard let display = Spaces.displayId(of: target), let frame = AX.frame(window.element) else {
            throw CarryError.failed("cannot find Desktop \(target.number)'s screen")
        }
        let b = CGDisplayBounds(display)
        let screen = Rect(x: b.origin.x, y: b.origin.y, width: b.width, height: b.height)
        let spot = CrossDisplay.position(window: frame, screen: screen)
        _ = AX.setPosition(window.element, x: spot.x, y: spot.y)
        try session.sleep(CarryDelays.beforeVerify)
        guard CarryCheck.moved(spacesAfter: Spaces.spaces(ofWindow: window.windowId), target: target.id) else {
            throw CarryError.failed("window did not move to the other display")
        }
    }

    /// After a failed try the screen may have slid away; come back to the window's desktop.
    private func goBack(to home: UInt64, window: CarryTarget) throws {
        guard !Spaces.isShowing(home) else { return }
        guard let back = Spaces.desktops().first(where: { $0.id == home }), let key = shortcuts[back.number] else {
            throw CarryError.failed("cannot return to the window's desktop")
        }
        DesktopKeys.post(key)
        try DesktopSwitch.wait(for: home, number: back.number, abort: session.check)
    }

    private func attempt(_ window: CarryTarget, to target: Desktop, key: DesktopShortcut, scale: Double) throws -> Bool {
        try session.check()
        NSRunningApplication(processIdentifier: window.pid)?.activate(options: [])
        AX.perform(window.element, kAXRaiseAction as String)
        try session.sleep(CarryDelays.afterRaise * scale)

        let saved = CarrySession.pointer
        defer { session.releaseMouse() }
        try grab(window, pointer: saved, scale: scale)
        DesktopKeys.post(key)
        try DesktopSwitch.wait(for: target.id, number: target.number, abort: session.check)
        try session.sleep(CarryDelays.settleAfterSwitch * scale)
        session.releaseMouse()
        try session.sleep(CarryDelays.beforeVerify * scale)
        return CarryCheck.moved(spacesAfter: Spaces.spaces(ofWindow: window.windowId), target: target.id)
    }

    /// Tries each grab point until one really drags the window, and leaves the mouse down on it.
    private func grab(_ window: CarryTarget, pointer saved: CGPoint, scale: Double) throws {
        guard let frame = AX.frame(window.element) else { throw CarryError.failed("no window frame") }
        let zoom = AX.element(window.element, kAXZoomButtonAttribute as String).flatMap(AX.frame)
        let candidates = CarryGrab.candidates(zoomButton: zoom, window: frame, screens: Spaces.screenFrames(),
                                              preferred: CarrySession.grabKind(for: window.bundleId))
        guard !candidates.isEmpty else { throw CarryError.failed("no grab point on a screen") }
        for candidate in candidates {
            session.savePointer(saved)
            if try startDrag(candidate, window: window, scale: scale) {
                CarrySession.remember(candidate.kind, for: window.bundleId)
                return
            }
            session.releaseMouse()
            try session.sleep(CarryDelays.betweenGrabTries * scale)
        }
        throw CarryError.failed("no grab point started a window drag (tried \(candidates.map(\.kind.rawValue).joined(separator: ", ")))")
    }

    /// Mouse-down, a short drag out and back. True when the window followed, which leaves it held at the grab point.
    private func startDrag(_ candidate: CarryGrabCandidate, window: CarryTarget, scale: Double) throws -> Bool {
        guard let before = Spaces.bounds(ofWindow: window.windowId) else { throw CarryError.failed("no window bounds") }
        let flags: CGEventFlags = candidate.kind.holdsOption ? .maskAlternate : []
        session.post(.mouseMoved, at: candidate.point, flags: flags)
        try session.sleep(CarryDelays.afterMoveToGrabPoint * scale)
        session.mouseDown(at: candidate.point, flags: flags)
        try session.sleep(CarryDelays.afterMouseDown * scale)
        for point in CarryGrab.dragOut(candidate) {
            session.drag(to: point)
            try session.sleep(CarryDelays.betweenDragSteps * scale)
        }
        var started = false
        let end = Date().addingTimeInterval(CarryDelays.dragStartTimeout * scale)
        while !started && Date() < end {
            if let now = Spaces.bounds(ofWindow: window.windowId) { started = CarryGrab.dragStarted(before: before, after: now) }
            if !started { try session.sleep(CarryDelays.switchPollInterval) }
        }
        for point in CarryGrab.dragBack(candidate) {
            session.drag(to: point)
            try session.sleep(CarryDelays.betweenDragSteps * scale)
        }
        return started
    }
}

enum AXBool {
    static func read(_ element: AXUIElement, _ attribute: String) -> Bool? {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &ref) == .success else { return nil }
        return ref as? Bool
    }
}

/// Finds a window's element again by its number, in every process with the bundle id (a second, windowless
/// Chrome must not hide the one the owner uses). Used when a cached element went stale.
enum CarryWindows {
    static func find(windowId: UInt32, bundleId: String) -> (pid: pid_t, element: AXUIElement)? {
        for app in NSRunningApplication.runningApplications(withBundleIdentifier: bundleId) {
            let pid = app.processIdentifier
            if let element = AX.windows(of: AX.appElement(pid: pid)).first(where: { AX.windowNumber($0) == windowId }) {
                return (pid, element)
            }
        }
        return nil
    }
}
