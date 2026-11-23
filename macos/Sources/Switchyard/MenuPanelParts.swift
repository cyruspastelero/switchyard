import SwiftUI

/// App name, a health dot, and when something is wrong: one plain line plus the fix.
struct MenuPanelHeader: View {
    let health: MenuPanelLogic.Health
    let actionProblem: String?
    let requestAccessibility: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text("Switchyard").font(.headline)
                Spacer()
                Circle()
                    .fill(health == .ok ? Color.green : Color.orange)
                    .frame(width: 8, height: 8)
                    .accessibilityHidden(true)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Switchyard")
            .accessibilityValue(MenuPanelLogic.healthLabel(health))
            .accessibilityAddTraits(.isHeader)

            if case let .problem(line, fix) = health {
                VStack(alignment: .leading, spacing: 4) {
                    Text(line)
                    switch fix {
                    case .allowAccessibility:
                        Button("Allow in Accessibility settings", action: requestAccessibility)
                            .controlSize(.small)
                    case let .command(text):
                        Text(text).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                }
                .font(.subheadline)
                .fixedSize(horizontal: false, vertical: true)
            }
            if let problem = actionProblem {
                Label {
                    Text(problem).fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                }
                .font(.subheadline)
                .accessibilityElement(children: .combine)
            }
        }
        .padding(.horizontal, 8)
        .padding(.top, 2)
    }
}

/// The status dot. Parked is an outline so it differs by shape, not only colour; the text says it anyway.
struct StatusDotView: View {
    let tone: MenuPanelLogic.Tone

    var body: some View {
        Group {
            switch tone {
            case .working: Circle().fill(Color.green)
            case .waiting: Circle().fill(Color.yellow)
            case .idle: Circle().fill(Color.secondary.opacity(0.6))
            case .parked: Circle().strokeBorder(Color.secondary, lineWidth: 1.5)
            }
        }
        .frame(width: 9, height: 9)
        .accessibilityHidden(true)
    }
}

/// One context: dot, name, status and window count, ⌥N. Highlighted when active and when selected or hovered.
struct ContextRow: View {
    let context: ContextDTO
    let active: Bool
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                StatusDotView(tone: MenuPanelLogic.tone(context.status))
                VStack(alignment: .leading, spacing: 1) {
                    Text(context.name).fontWeight(active ? .semibold : .regular).lineLimit(1)
                    Text(MenuPanelLogic.detail(context)).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 8)
                if let key = MenuPanelLogic.shortcut(context) {
                    Text(key).foregroundStyle(.secondary).monospacedDigit()
                }
            }
            .padding(.horizontal, 8)
            .frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
            .background(highlight, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(MenuPanelLogic.accessibilityLabel(context))
        .accessibilityHint("Switches to this context")
        .accessibilityAddTraits(active ? [.isButton, .isSelected] : .isButton)
    }

    private var highlight: Color {
        switch (active, selected) {
        case (true, true): return Color.accentColor.opacity(0.32)
        case (true, false): return Color.accentColor.opacity(0.18)
        case (false, true): return Color.primary.opacity(0.1)
        case (false, false): return .clear
        }
    }
}

/// A compact icon-over-title button for the bottom row, with a hover highlight like Control Center.
struct PanelButton: View {
    let title: String
    let symbol: String
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 3) {
                Image(systemName: symbol).font(.system(size: 15)).frame(height: 18)
                Text(title).font(.caption).lineLimit(1)
            }
            .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(PanelButtonStyle())
        .help(label)
        .accessibilityLabel(label)
    }
}

private struct PanelButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @State private var hovering = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(isEnabled ? .primary : .tertiary)
            .background(fill(pressed: configuration.isPressed),
                        in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .onHover { hovering = $0 && isEnabled }
    }

    private func fill(pressed: Bool) -> Color {
        pressed ? Color.primary.opacity(0.16) : hovering ? Color.primary.opacity(0.08) : .clear
    }
}
