import AppKit
import SwiftUI

enum ContextFilter {
    /// Case-insensitive substring match on name, status or key; every word must match.
    static func filter(_ contexts: [ContextDTO], query: String) -> [ContextDTO] {
        let words = query.lowercased().split(separator: " ").map(String.init)
        guard !words.isEmpty else { return contexts }
        return contexts.filter { c in
            let hay = "\(c.name) \(c.status) \(c.key.map(String.init) ?? "")".lowercased()
            return words.allSatisfy { hay.contains($0) }
        }
    }
}

@MainActor
final class SwitcherModel: ObservableObject {
    @Published var query = "" { didSet { selected = 0 } }
    @Published var selected = 0
    var all: [ContextDTO] = []

    var items: [ContextDTO] { ContextFilter.filter(all, query: query) }

    func move(_ delta: Int) {
        let n = items.count
        guard n > 0 else { return }
        selected = (selected + delta + n) % n
    }

    var current: ContextDTO? {
        let list = items
        return list.indices.contains(selected) ? list[selected] : nil
    }
}

private final class KeyPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

private struct SwitcherView: View {
    @ObservedObject var model: SwitcherModel
    let onPick: (Int) -> Void
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            TextField("Switch to context", text: $model.query)
                .textFieldStyle(.plain)
                .font(.system(size: 22))
                .padding(14)
                .focused($focused)
            Divider()
            if model.items.isEmpty {
                Text("No matching context").foregroundStyle(.secondary).padding(14)
            } else {
                ScrollView { LazyVStack(spacing: 2) { rows } .padding(6) }
            }
        }
        .frame(width: 520, height: 340, alignment: .top)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
        .onAppear { focused = true }
    }

    private var rows: some View {
        ForEach(Array(model.items.enumerated()), id: \.element.id) { index, c in
            HStack(spacing: 10) {
                Image(nsImage: StatusDot.image(hex: c.color))
                Text(c.name).font(.system(size: 15))
                Spacer()
                Text(StatusDot.label(c.status)).foregroundStyle(.secondary).font(.system(size: 12))
                if let k = c.key { Text("⌥\(k)").foregroundStyle(.secondary).font(.system(size: 12, design: .monospaced)) }
            }
            .padding(.horizontal, 10).padding(.vertical, 7)
            .background(index == model.selected ? Color.accentColor.opacity(0.25) : .clear, in: RoundedRectangle(cornerRadius: 8))
            .contentShape(Rectangle())
            .onHover { if $0 { model.selected = index } }
            .onTapGesture { onPick(index) }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
        }
    }
}

/// Floating search switcher: ⌥Space toggles it; type, ↑/↓, Enter, Esc.
@MainActor
final class SwitcherController {
    private let model = SwitcherModel()
    private var panel: KeyPanel?
    private var keyMonitor: Any?
    private var resignObserver: NSObjectProtocol?
    /// The app that was in front before ⌥Space, so Esc can hand focus back.
    private var previousApp: NSRunningApplication?
    var onPick: ((String) -> Void)?

    var isVisible: Bool { panel?.isVisible ?? false }

    func toggle(contexts: [ContextDTO]) {
        if isVisible { close() } else { show(contexts: contexts) }
    }

    private func show(contexts: [ContextDTO]) {
        model.all = contexts
        model.query = ""
        let p = panel ?? makePanel()
        panel = p
        position(p)
        // A menu-bar app is never active on its own; without this, typing and arrows go to the app behind.
        previousApp = NSWorkspace.shared.frontmostApplication
        NSApp.activate(ignoringOtherApps: true)
        p.makeKeyAndOrderFront(nil)
        installMonitor()
    }

    func close() {
        dismiss()
        if let app = previousApp, app != NSRunningApplication.current { app.activate() }
        previousApp = nil
    }

    private func dismiss() {
        panel?.orderOut(nil)
        if let m = keyMonitor { NSEvent.removeMonitor(m); keyMonitor = nil }
    }

    private func makePanel() -> KeyPanel {
        let p = KeyPanel(contentRect: NSRect(x: 0, y: 0, width: 520, height: 340),
                         styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        p.isFloatingPanel = true
        p.level = .floating
        p.hidesOnDeactivate = false
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        p.contentView = NSHostingView(rootView: SwitcherView(model: model) { [weak self] index in
            self?.model.selected = index
            self?.pick()
        })
        resignObserver = NotificationCenter.default.addObserver(forName: NSWindow.didResignKeyNotification, object: p, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.close() }
        }
        return p
    }

    private func position(_ p: NSPanel) {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { $0.frame.contains(mouse) } ?? NSScreen.main
        guard let f = screen?.visibleFrame else { return }
        p.setFrameOrigin(NSPoint(x: f.midX - p.frame.width / 2, y: f.maxY - p.frame.height - f.height * 0.18))
    }

    private func installMonitor() {
        guard keyMonitor == nil else { return }
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, self.isVisible else { return event }
            switch event.keyCode {
            case 126: self.model.move(-1); return nil          // up
            case 125: self.model.move(1); return nil           // down
            case 36, 76: self.pick(); return nil               // return, enter
            case 53: self.close(); return nil                  // escape
            default: return event
            }
        }
    }

    private func pick() {
        guard let c = model.current else { return }
        // The switch raises the target's windows; don't hand focus back to the old app first.
        previousApp = nil
        dismiss()
        onPick?(c.id)
    }
}
