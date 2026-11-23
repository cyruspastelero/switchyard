import AppKit
import Foundation

/// Reads the windows on the desktop on screen as layout preset slots (see `PresetLayout.capture`).
struct LayoutCapture {
    let windows: WindowLayer

    func slots() async throws -> [LayoutSlotDTO] {
        guard let desktop = Spaces.activeDesktopNumber() else { throw CommandError.unsupported("this space is not a desktop") }
        _ = await windows.refresh()
        let list = Spaces.desktops()
        let here = await windows.tidyCandidates(await windows.manualTidyKeys()).filter { w in
            w.windowNumber.flatMap { Spaces.desktopNumber(ofWindow: $0, in: list) } == desktop
        }
        let z = Spaces.zOrder()
        let captured = here.map { w in
            CaptureWindow(bundleId: w.bundleId, app: w.app, frame: AX.frame(w.id.element) ?? w.frame,
                          z: w.windowNumber.flatMap { z[$0] } ?? Int.max)
        }
        let screens = await MainActor.run(body: { PresetScreens.current() })
        let slots = PresetLayout.capture(captured, screens: screens)
        guard !slots.isEmpty else { throw CommandError.unsupported("no windows on Desktop \(desktop) to save") }
        Log.windows.notice("layout captured desktop=\(desktop, privacy: .public) slots=\(slots.count, privacy: .public)")
        return slots
    }
}

/// The name prompt behind "Save layout…".
enum LayoutNamePrompt {
    /// nil when the owner cancels. An empty name falls back to `defaultName`.
    @MainActor
    static func ask(defaultName: String) -> String? {
        let alert = NSAlert()
        alert.messageText = "Save layout"
        alert.informativeText = "Saves where the windows on this desktop are now. Tidy puts them back there."
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 240, height: 24))
        field.stringValue = defaultName
        alert.accessoryView = field
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return nil }
        let name = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return String((name.isEmpty ? defaultName : name).prefix(100))
    }
}
