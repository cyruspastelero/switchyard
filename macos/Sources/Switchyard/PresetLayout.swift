import AppKit
import CoreGraphics
import Foundation

// Layout presets: the owner arranges a desktop by hand, saves it, and Tidy puts windows back there.
// Slot frames are fractions of the screen's visible area. Accessibility coordinates throughout.

/// A screen as presets see it. `uuid` comes from CGDisplayCreateUUIDFromDisplayID.
struct PresetScreen: Equatable {
    let uuid: String
    let builtin: Bool
    let frame: Rect
    /// The visible area (no menu bar or Dock).
    let area: Rect
    let isMain: Bool
}

/// A window being saved. `z`: 0 is front-most.
struct CaptureWindow: Equatable {
    let bundleId: String
    let app: String
    let frame: Rect
    let z: Int
}

/// A window being placed from a preset.
struct PresetWindow: Equatable {
    let key: String
    let bundleId: String
    let z: Int
    let number: UInt32
}

/// Which screens a preset may place windows on.
enum ScreenScope: Equatable {
    /// One set of Spaces across displays: any screen.
    case anyScreen
    /// Separate Spaces: only the desktop's own display; nil (its id is unknown) places nothing.
    case only(String?)
}

enum PresetLayout {
    static let maxSlots = 50
    /// Each extra window of an app sits this much lower and to the right on that app's last slot.
    static let deckStep = 30.0

    /// Slots front to back, each on the screen holding the window's center. Frames are clipped to that screen.
    static func capture(_ windows: [CaptureWindow], screens: [PresetScreen]) -> [LayoutSlotDTO] {
        let ordered = windows.sorted { $0.z < $1.z }
        let slots = ordered.compactMap { w -> LayoutSlotDTO? in
            guard !w.bundleId.isEmpty, w.bundleId.count <= 200, w.frame.width > 0, w.frame.height > 0,
                  let hit = FrameMath.screen(containing: w.frame, in: screens.map(\.frame)),
                  let screen = screens.first(where: { $0.frame == hit }),
                  let f = fractions(w.frame, of: screen.area) else { return nil }
            return LayoutSlotDTO(bundleId: w.bundleId, app: String(w.app.prefix(100)),
                                 screen: SlotScreen(uuid: screen.uuid, builtin: screen.builtin), frame: f)
        }
        return Array(slots.prefix(maxSlots))
    }

    private static func fractions(_ frame: Rect, of area: Rect) -> SlotFrame? {
        let x0 = max(frame.x, area.x), y0 = max(frame.y, area.y)
        let x1 = min(frame.maxX, area.maxX), y1 = min(frame.maxY, area.maxY)
        guard x1 > x0, y1 > y0, area.width > 0, area.height > 0 else { return nil }
        func r(_ v: Double) -> Double { (min(max(v, 0), 1) * 10_000).rounded() / 10_000 }
        let w = r((x1 - x0) / area.width), h = r((y1 - y0) / area.height)
        guard w > 0, h > 0 else { return nil }
        return SlotFrame(x: r((x0 - area.x) / area.width), y: r((y0 - area.y) / area.height), w: w, h: h)
    }

    /// The slot's screen if connected, else one with the same built-in flag, else the main one.
    static func screen(for slot: LayoutSlotDTO, in screens: [PresetScreen]) -> PresetScreen? {
        screens.first { $0.uuid.caseInsensitiveCompare(slot.screen.uuid) == .orderedSame }
            ?? screens.first { $0.builtin == slot.screen.builtin }
            ?? screens.first(where: \.isMain) ?? screens.first
    }

    /// Window key -> frame. An app's nth window (front to back) takes its nth slot; extra ones deck on its last.
    /// `scope`: with separate Spaces per display, slots on any other screen are skipped (the window stays put).
    static func assign(_ windows: [PresetWindow], slots: [LayoutSlotDTO], screens: [PresetScreen],
                       scope: ScreenScope = .anyScreen) -> [String: Rect] {
        if scope == .only(nil) { return [:] }
        let byApp = Dictionary(grouping: slots, by: \.bundleId)
        var frames: [String: Rect] = [:]
        for (bundleId, wins) in Dictionary(grouping: windows, by: \.bundleId) {
            guard let appSlots = byApp[bundleId], let lastSlot = appSlots.last else { continue }
            let ordered = wins.sorted { ($0.z, $0.number, $0.key) < ($1.z, $1.number, $1.key) }
            for (i, w) in ordered.enumerated() {
                let slot = i < appSlots.count ? appSlots[i] : lastSlot
                let step = Double(max(0, i - appSlots.count + 1)) * deckStep
                guard let screen = screen(for: slot, in: screens) else { continue }
                if case .only(let own?) = scope, screen.uuid.caseInsensitiveCompare(own) != .orderedSame { continue }
                frames[w.key] = place(slot.frame, in: screen.area, offset: step)
            }
        }
        return frames
    }

    private static func place(_ f: SlotFrame, in area: Rect, offset: Double) -> Rect {
        let r = Rect(x: (area.x + f.x * area.width).rounded() + offset, y: (area.y + f.y * area.height).rounded() + offset,
                     width: (f.w * area.width).rounded(), height: (f.h * area.height).rounded())
        return offset == 0 ? r : Layout.fit(r, slot: r, area: area, gap: 0)
    }

    /// Windows of apps the preset has no slot for, front to back: those get the automatic layout.
    static func unslotted(_ windows: [PresetWindow], slots: [LayoutSlotDTO]) -> [String] {
        let apps = Set(slots.map(\.bundleId))
        return windows.filter { !apps.contains($0.bundleId) }.sorted { $0.z < $1.z }.map(\.key)
    }
}

/// Shared Spaces: a desktop spans every screen, so the automatic layout runs once per screen.
enum TidyScreens {
    /// Screen index -> keys of the windows mostly on it. A window on no screen is left out.
    static func group(_ windows: [(key: String, frame: Rect)], screens: [Rect]) -> [Int: [String]] {
        var groups: [Int: [String]] = [:]
        for w in windows {
            let overlaps = screens.enumerated().map { ($0.offset, overlap(w.frame, $0.element)) }
            guard let best = overlaps.max(by: { $0.1 < $1.1 }), best.1 > 0 else { continue }
            groups[best.0, default: []].append(w.key)
        }
        return groups
    }

    private static func overlap(_ a: Rect, _ b: Rect) -> Double {
        max(0, min(a.maxX, b.maxX) - max(a.x, b.x)) * max(0, min(a.maxY, b.maxY) - max(a.y, b.y))
    }
}

/// The default name for a new preset, as the server picks it.
enum LayoutNames {
    static func next(taken: [String]) -> String {
        let names = Set(taken)
        var n = 1
        while names.contains("Layout \(n)") { n += 1 }
        return "Layout \(n)"
    }
}

/// The live screens. NSScreen, so main actor only.
enum PresetScreens {
    @MainActor
    static func current() -> [PresetScreen] {
        guard let primary = NSScreen.screens.first else { return [] }
        let h = primary.frame.height
        let number = NSDeviceDescriptionKey("NSScreenNumber")
        return NSScreen.screens.compactMap { s in
            guard let id = (s.deviceDescription[number] as? NSNumber)?.uint32Value else { return nil }
            let f = s.frame, v = s.visibleFrame
            return PresetScreen(uuid: Spaces.displayUUID(id) ?? "", builtin: CGDisplayIsBuiltin(id) != 0,
                                frame: FrameMath.fromCocoa(Rect(x: f.minX, y: f.minY, width: f.width, height: f.height), primaryHeight: h),
                                area: Layout.area(visibleFrame: Rect(x: v.minX, y: v.minY, width: v.width, height: v.height), primaryHeight: h),
                                isMain: id == CGMainDisplayID())
        }
    }
}
