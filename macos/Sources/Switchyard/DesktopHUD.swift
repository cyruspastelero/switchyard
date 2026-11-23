import AppKit

/// What the arrival HUD says. Pure, so it is tested.
struct HUDText: Equatable {
    let title: String
    let hint: String?

    static let maxName = 28

    /// `strays`: the desktops of the context's windows that sit elsewhere. `unsortedHere`: unsorted windows on this
    /// (project) desktop, which Sort carries to `sharedDesktop`.
    static func make(contextName: String?, desktop: Int, shared: Bool, strays: [Int], unsortedHere: Int,
                     sharedDesktop: Int?) -> HUDText {
        let title: String
        if shared { title = "Shared · Desktop \(desktop)" } else if let name = contextName {
            title = "\(cut(name, to: maxName)) · Desktop \(desktop)"
        } else { title = "Desktop \(desktop)" }
        return HUDText(title: title, hint: hint(strays: strays, unsortedHere: unsortedHere, sharedDesktop: sharedDesktop))
    }

    private static func hint(strays: [Int], unsortedHere: Int, sharedDesktop: Int?) -> String? {
        if let text = strayText(strays) { return "\(text) · Sort" }
        guard unsortedHere > 0, let sharedDesktop else { return nil }
        return unsortedHere == 1
            ? "1 window here is unsorted · Sort moves it to Desktop \(sharedDesktop)"
            : "\(unsortedHere) windows here are unsorted · Sort moves them to Desktop \(sharedDesktop)"
    }

    /// "1 window still on Desktop 1"; nil without strays.
    static func strayText(_ strays: [Int]) -> String? {
        guard let first = strays.first else { return nil }
        let count = strays.count == 1 ? "1 window" : "\(strays.count) windows"
        let place = Set(strays).count == 1 ? "Desktop \(first)" : "other desktops"
        return "\(count) still on \(place)"
    }

    static func cut(_ text: String, to limit: Int) -> String {
        text.count <= limit ? text : String(text.prefix(limit - 1)) + "…"
    }
}

/// A small label near the top of the screen for 0.9 s after landing on a desktop. Never takes focus or the mouse.
@MainActor
final class DesktopHUD {
    static let duration: TimeInterval = 0.9

    private var panel: NSPanel?
    private var hideWork: DispatchWorkItem?

    func show(_ text: HUDText) {
        let panel = self.panel ?? make()
        self.panel = panel
        guard let label = panel.contentView?.subviews.first as? NSTextField, let screen = NSScreen.screens.first else { return }
        label.stringValue = text.hint.map { "\(text.title)\n\($0)" } ?? text.title
        label.sizeToFit()
        let size = NSSize(width: label.frame.width + 32, height: label.frame.height + 18)
        let visible = screen.visibleFrame
        panel.setFrame(NSRect(x: visible.midX - size.width / 2, y: visible.maxY - size.height - 24,
                              width: size.width, height: size.height), display: true)
        label.frame.origin = NSPoint(x: 16, y: 9)
        hideWork?.cancel()
        panel.alphaValue = 1
        panel.orderFrontRegardless()
        let work = DispatchWorkItem { [weak self] in self?.fadeOut() }
        hideWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.duration, execute: work)
    }

    private func fadeOut() {
        guard let panel else { return }
        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion { panel.orderOut(nil); return }
        NSAnimationContext.runAnimationGroup({ $0.duration = 0.2; panel.animator().alphaValue = 0 },
                                             completionHandler: { panel.orderOut(nil) })
    }

    private func make() -> NSPanel {
        let panel = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        panel.level = .statusBar
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        let background = NSVisualEffectView()
        background.material = .hudWindow
        background.state = .active
        background.wantsLayer = true
        background.layer?.cornerRadius = 10
        panel.contentView = background
        let label = NSTextField(labelWithString: "")
        label.font = .systemFont(ofSize: 15, weight: .medium)
        label.alignment = .center
        label.maximumNumberOfLines = 2
        background.addSubview(label)
        return panel
    }
}
