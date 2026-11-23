import AppKit
import SwiftUI

/// Everything the panel shows, as plain values, so it can be rendered with mock data.
struct MenuPanelState {
    var contexts: [ContextDTO]
    var activeContextId: String?
    var unsortedCount: Int
    var serverProblem: String?
    var trusted: Bool
    var actionProblem: String?
    var sortProgress: String? = nil
    var toSortCount = 0
    var canUndoTidy = false

    var online: Bool { serverProblem == nil }
}

/// What the panel's controls do. `close` hides the panel.
struct MenuPanelActions {
    var switchTo: (String) -> Void
    var sortWindows: () -> Void
    var tidy: () -> Void = {}
    var undoTidy: () -> Void = {}
    var showAllWindows: () -> Void
    var copyAccessCode: () -> Void
    var openDashboard: () -> Void
    var requestAccessibility: () -> Void
    var quit: () -> Void
    var close: () -> Void
}

/// The live panel: feeds `MenuPanelView` from the app model.
struct MenuContent: View {
    @ObservedObject var model: AppModel
    @State private var window = WindowBox()

    var body: some View {
        MenuPanelView(
            state: MenuPanelState(contexts: model.contexts, activeContextId: model.activeContextId,
                                  unsortedCount: model.unsortedCount, serverProblem: model.serverProblem,
                                  trusted: model.trusted, actionProblem: model.actionProblem,
                                  sortProgress: model.sortProgress, toSortCount: model.toSortCount,
                                  canUndoTidy: model.canUndoTidy),
            actions: MenuPanelActions(
                switchTo: { model.switchTo($0) }, sortWindows: { model.sortWindows() },
                tidy: { model.tidyHere() }, undoTidy: { model.undoTidy() },
                showAllWindows: { model.showAllWindows() }, copyAccessCode: { model.copyAccessCode() },
                openDashboard: { model.openDashboard() }, requestAccessibility: { model.requestAccessibility() },
                quit: { model.quit() }, close: { window.close() }),
            window: window)
    }
}

/// Holds the panel's NSWindow so the view can close it and notice when it opens again.
final class WindowBox {
    weak var window: NSWindow?
    func close() { (window ?? NSApp.keyWindow)?.close() }
}

private struct WindowReader: NSViewRepresentable {
    let box: WindowBox
    func makeNSView(context: Context) -> NSView {
        let v = NSView()
        DispatchQueue.main.async { box.window = v.window }
        return v
    }
    func updateNSView(_ nsView: NSView, context: Context) {
        if box.window == nil { DispatchQueue.main.async { box.window = nsView.window } }
    }
}

struct MenuPanelView: View {
    let state: MenuPanelState
    let actions: MenuPanelActions
    var window = WindowBox()

    @State private var query = ""
    @State private var selection: Int?
    @FocusState private var searchFocused: Bool

    private var rows: [ContextDTO] { MenuPanelLogic.visibleRows(state.contexts, query: query) }
    private static let rowHeight: CGFloat = 44
    private static let maxVisibleRows = 7

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            MenuPanelHeader(health: MenuPanelLogic.health(serverProblem: state.serverProblem, trusted: state.trusted),
                            actionProblem: state.actionProblem, requestAccessibility: actions.requestAccessibility)
            if state.online {
                searchField
                contextList
                strayRow
                unsortedRow
                tidyRow
            }
            Divider().padding(.horizontal, 4)
            bottomButtons
        }
        .padding(10)
        .frame(width: 320)
        .background(WindowReader(box: window))
        .onAppear(perform: reset)
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { note in
            if let w = note.object as? NSWindow, w === window.window { reset() }
        }
        .onExitCommand { actions.close() }
    }

    private func reset() {
        query = ""
        selection = nil
        searchFocused = true
    }

    private func pick(_ id: String) {
        actions.close()
        actions.switchTo(id)
    }

    // MARK: Search

    private var searchField: some View {
        TextField("Search contexts", text: $query)
            .textFieldStyle(.roundedBorder)
            .focused($searchFocused)
            .accessibilityLabel("Search contexts")
            .onChange(of: query) { selection = rows.isEmpty || query.isEmpty ? nil : 0 }
            .onKeyPress(.downArrow) { moveSelection(1) }
            .onKeyPress(.upArrow) { moveSelection(-1) }
            .onKeyPress(.escape) { actions.close(); return .handled }
            .onSubmit { if let id = MenuPanelLogic.pick(rows: rows, selection: selection) { pick(id) } }
    }

    private func moveSelection(_ delta: Int) -> KeyPress.Result {
        selection = MenuPanelLogic.move(selection: selection, by: delta, count: rows.count)
        return .handled
    }

    // MARK: Contexts

    @ViewBuilder private var contextList: some View {
        let visible = rows
        if state.contexts.isEmpty {
            emptyNote(MenuStatus.lines(serverProblem: nil, trusted: true, contextCount: 0))
        } else if visible.isEmpty {
            emptyNote(["No matching context"])
        } else if visible.count > Self.maxVisibleRows {
            ScrollViewReader { proxy in
                ScrollView { rowStack(visible) }
                    .frame(height: Self.rowHeight * CGFloat(Self.maxVisibleRows) + 8)
                    .onChange(of: selection) { if let s = selection { proxy.scrollTo(visible[s].id) } }
            }
        } else {
            rowStack(visible)
        }
    }

    private func rowStack(_ visible: [ContextDTO]) -> some View {
        VStack(spacing: 2) {
            ForEach(Array(visible.enumerated()), id: \.element.id) { index, c in
                ContextRow(context: c, active: c.id == state.activeContextId, selected: index == selection) {
                    pick(c.id)
                }
                .id(c.id)
                .onHover { if $0 { selection = index } }
            }
        }
    }

    private func emptyNote(_ lines: [String]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(lines.enumerated()), id: \.offset) { i, line in
                Text(line)
                    .font(i == 0 ? .body : .subheadline)
                    .foregroundStyle(i == 0 ? .primary : .secondary)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, 8).padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }

    private func actionRow(_ text: String, button: String, action: @escaping () -> Void) -> some View {
        HStack(spacing: 4) {
            Text(text).foregroundStyle(.secondary)
            Text("·").foregroundStyle(.secondary).accessibilityHidden(true)
            Button(button, action: action)
                .buttonStyle(.link)
                .disabled(!state.trusted)
                .accessibilityLabel("\(button) \(text)")
            Spacer(minLength: 0)
        }
        .font(.subheadline)
        .padding(.horizontal, 8)
    }

    /// "1 window still on Desktop 1 · Sort": the active context has a window the switch could not show.
    @ViewBuilder private var strayRow: some View {
        if state.sortProgress == nil, let active = state.contexts.first(where: { $0.id == state.activeContextId }),
           let text = HUDText.strayText(ContextStrays.desktops(active)) {
            actionRow(text, button: "Sort", action: actions.sortWindows)
        }
    }

    private var tidyRow: some View {
        HStack(spacing: 8) {
            Button("Tidy this desktop", action: actions.tidy)
                .buttonStyle(.link)
                .disabled(!state.trusted || state.sortProgress != nil)
            if state.canUndoTidy {
                Button("Undo tidy", action: actions.undoTidy).buttonStyle(.link)
            }
            Spacer(minLength: 0)
            Text("⌥T").foregroundStyle(.secondary).accessibilityLabel("Option T")
        }
        .font(.subheadline)
        .padding(.horizontal, 8)
    }

    @ViewBuilder private var unsortedRow: some View {
        if let progress = state.sortProgress {
            Text(progress)
                .font(.subheadline).foregroundStyle(.secondary)
                .padding(.horizontal, 8)
                .accessibilityAddTraits(.updatesFrequently)
        } else if let text = MenuPanelLogic.toSortText(state.toSortCount) {
            actionRow(text, button: "Sort now", action: actions.sortWindows)
        } else if let text = MenuPanelLogic.unsortedText(state.unsortedCount) {
            // Sorting can't place a window that matches no context; it needs the owner to pick one.
            actionRow(text, button: "Assign…", action: actions.openDashboard)
        }
    }

    // MARK: Buttons

    private var bottomButtons: some View {
        HStack(spacing: 4) {
            PanelButton(title: "Dashboard", symbol: "safari", label: "Open dashboard", action: actions.openDashboard)
                .disabled(!state.online)
            PanelButton(title: "Show all", symbol: "macwindow.on.rectangle", label: "Show all windows",
                        action: actions.showAllWindows)
            PanelButton(title: "Copy code", symbol: "key", label: "Copy dashboard access code",
                        action: actions.copyAccessCode)
                .disabled(!state.online)
            PanelButton(title: "Quit", symbol: "power", label: "Quit Switchyard", action: actions.quit)
        }
    }
}
