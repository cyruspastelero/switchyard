import AppKit
import ApplicationServices

// Adding and closing desktops. macOS has no public API to remove a Space, so this drives Mission Control's
// spaces bar through Accessibility on the Dock process, as Hammerspoon's hs.spaces does.
// Assumed Dock tree (not yet checked on this Mac): an element with AXIdentifier "mc", one "mc.display" group per
// display, each holding "mc.spaces" with "mc.spaces.list" (one button per space, fullscreen ones too) and
// "mc.spaces.add". A desktop button takes the action "AXRemoveDesktop"; the add button takes AXPress.
// Pure choices (which button, which display) are in DesktopAdmin.swift. Blocking: call off the main thread.

enum MissionControl {
    private static let openTimeout: TimeInterval = 2
    private static let verifyTimeout: TimeInterval = 3
    private static let poll: TimeInterval = 0.05
    private static let escapeKeyCode: CGKeyCode = 53

    /// Closes desktop `number`, only while it is still `space`. Throws with a plain reason; never closes another one.
    static func close(number: Int, space: UInt64) throws {
        let target = try DesktopAdmin.closeTarget(Spaces.displays(), number: number, space: space).get()
        try withMissionControl { mc in
            let buttons = try spaceButtons(in: mc, target: target)
            // Re-read right before acting: the owner may have changed desktops while Mission Control opened.
            guard try DesktopAdmin.closeTarget(Spaces.displays(), number: number, space: space).get() == target else {
                throw DesktopAdminError.changed(number)
            }
            guard AX.perform(buttons[target.buttonIndex], "AXRemoveDesktop") else {
                throw CommandError.unsupported("Mission Control did not close Desktop \(number)")
            }
        }
        guard waitUntil({ DesktopAdmin.isGone(Spaces.displays(), space: space) }) else {
            throw CommandError.unsupported("Desktop \(number) is still there after asking Mission Control to close it")
        }
    }

    /// Adds a desktop at the end of `screen`'s row.
    static func add(screen: Int) throws {
        let target = try DesktopAdmin.addTarget(Spaces.displays(), screen: screen).get()
        let before = DesktopAdmin.desktopCount(Spaces.displays(), displayId: target.displayId)
        try withMissionControl { mc in
            let group = try displayGroup(in: mc, displayId: target.displayId)
            guard let add = find(group, "mc.spaces.add"), AX.perform(add, kAXPressAction as String) else {
                throw CommandError.unsupported("Mission Control has no add button for screen \(screen)")
            }
        }
        guard waitUntil({ DesktopAdmin.desktopCount(Spaces.displays(), displayId: target.displayId) > before }) else {
            throw CommandError.unsupported("no new desktop showed up on screen \(screen)")
        }
    }

    // MARK: Accessibility

    private static func withMissionControl(_ work: (AXUIElement) throws -> Void) throws {
        guard AX.isTrusted(prompt: false) else { throw CommandError.unsupported("Switchyard needs Accessibility to use Mission Control") }
        guard let dock = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").first else {
            throw CommandError.unsupported("the Dock is not running")
        }
        let app = AX.appElement(pid: dock.processIdentifier)
        open()
        defer { dismiss(app) }
        var mc: AXUIElement?
        _ = waitUntil(timeout: openTimeout) { mc = find(app, "mc", depth: 2); return mc != nil }
        guard let mc else { throw CommandError.unsupported("Mission Control did not open") }
        Thread.sleep(forTimeInterval: 0.3) // the spaces bar fills in after the zoom starts
        try work(mc)
    }

    private static func open() {
        let url = URL(fileURLWithPath: "/System/Applications/Mission Control.app")
        NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration()) { _, error in
            if let error { Log.windows.error("opening Mission Control failed: \(error.localizedDescription, privacy: .public)") }
        }
    }

    /// Escape closes Mission Control; it is a no-op once it is gone.
    private static func dismiss(_ dock: AXUIElement) {
        guard find(dock, "mc", depth: 2) != nil else { return }
        let source = CGEventSource(stateID: .hidSystemState)
        for down in [true, false] {
            CGEvent(keyboardEventSource: source, virtualKey: escapeKeyCode, keyDown: down)?.post(tap: .cghidEventTap)
        }
        if !waitUntil(timeout: 1, { find(dock, "mc", depth: 2) == nil }) {
            Log.windows.error("Mission Control is still open after Escape")
        }
    }

    /// The display's group, matched by frame against that display's bounds.
    private static func displayGroup(in mc: AXUIElement, displayId: String) throws -> AXUIElement {
        let groups = AX.children(mc).filter { AX.string($0, kAXIdentifierAttribute as String) == "mc.display" }
        if groups.count == 1 { return groups[0] }
        guard let id = Spaces.cgDisplay(displayId) else { throw CommandError.unsupported("that screen is not connected") }
        let b = CGDisplayBounds(id)
        let screen = Rect(x: b.origin.x, y: b.origin.y, width: b.width, height: b.height)
        guard let index = DesktopAdmin.matchDisplay(frames: groups.map(AX.frame), screen: screen) else {
            throw CommandError.unsupported("Mission Control shows no row for that screen")
        }
        return groups[index]
    }

    private static func spaceButtons(in mc: AXUIElement, target: SpaceButton) throws -> [AXUIElement] {
        guard let list = find(try displayGroup(in: mc, displayId: target.displayId), "mc.spaces.list") else {
            throw CommandError.unsupported("Mission Control shows no desktops for that screen")
        }
        let buttons = AX.children(list)
        guard buttons.count == target.buttonCount else {
            throw CommandError.unsupported("Mission Control shows \(buttons.count) spaces on that screen, expected \(target.buttonCount); nothing was closed")
        }
        return buttons
    }

    /// Breadth-first search for an element with this AXIdentifier.
    private static func find(_ root: AXUIElement, _ identifier: String, depth: Int = 4) -> AXUIElement? {
        var level = [root]
        for _ in 0...depth {
            if let hit = level.first(where: { AX.string($0, kAXIdentifierAttribute as String) == identifier }) { return hit }
            level = level.flatMap(AX.children)
            if level.isEmpty { return nil }
        }
        return nil
    }

    private static func waitUntil(timeout: TimeInterval = verifyTimeout, _ done: () -> Bool) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if done() { return true }
            Thread.sleep(forTimeInterval: poll)
        }
        return done()
    }
}
