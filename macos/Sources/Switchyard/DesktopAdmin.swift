import Foundation

// Adding and closing desktops: the pure part. Reads `CGSCopyManagedDisplaySpaces` output and decides which
// Mission Control button to act on. The Accessibility walking lives in MissionControl.swift.

enum DesktopAdminError: Error, LocalizedError, Equatable {
    case noSuchDesktop(Int)
    case changed(Int)
    case lastOnScreen(Int)
    case noSuchScreen(Int)

    var errorDescription: String? {
        switch self {
        case .noSuchDesktop(let n): return "there is no Desktop \(n)"
        case .changed(let n): return "Desktop \(n) changed since the dashboard last looked; nothing was closed"
        case .lastOnScreen(let n): return "Desktop \(n) is the only desktop on its screen"
        case .noSuchScreen(let s): return "there is no screen \(s)"
        }
    }
}

/// A display's row in Mission Control's spaces bar. `buttonIndex` counts fullscreen spaces too, as the bar does.
/// For an add it is the index the new desktop will take.
struct SpaceButton: Equatable {
    let displayIndex: Int
    let displayId: String
    let buttonIndex: Int
    let buttonCount: Int
}

enum DesktopAdmin {
    /// The snapshot's desktop list: usable desktops only, screens numbered 1… in the order desktops are.
    static func entries(_ desktops: [Desktop], showing: Set<UInt64>, builtin: (String) -> Bool) -> [DesktopEntryDTO] {
        let screens = screenOrder(desktops)
        return desktops.prefix(DesktopList.usableCount(desktops)).map { d in
            DesktopEntryDTO(number: d.number, space: d.id, screen: (screens.firstIndex(of: d.displayId) ?? 0) + 1,
                            builtin: builtin(d.displayId), showing: showing.contains(d.id))
        }
    }

    /// Display ids that hold at least one desktop, in numbering order.
    static func screenOrder(_ desktops: [Desktop]) -> [String] {
        var order: [String] = []
        for d in desktops where !order.contains(d.displayId) { order.append(d.displayId) }
        return order
    }

    /// The button for desktop `number`, but only while it is still the space the server saw.
    static func closeTarget(_ displays: [[String: Any]], number: Int, space: UInt64) -> Result<SpaceButton, DesktopAdminError> {
        let desktops = DesktopList.parse(displays, mainDisplayId: nil)
        guard let d = desktops.first(where: { $0.number == number }) else { return .failure(.noSuchDesktop(number)) }
        guard d.id == space else { return .failure(.changed(number)) }
        guard desktops.filter({ $0.displayId == d.displayId }).count > 1 else { return .failure(.lastOnScreen(number)) }
        guard let index = displays.firstIndex(where: { ($0["Display Identifier"] as? String ?? "") == d.displayId }) else {
            return .failure(.noSuchDesktop(number))
        }
        let ids = spaceIds(displays[index])
        guard let button = ids.firstIndex(of: space) else { return .failure(.noSuchDesktop(number)) }
        return .success(SpaceButton(displayIndex: index, displayId: d.displayId, buttonIndex: button, buttonCount: ids.count))
    }

    /// The display a new desktop on `screen` goes to (macOS adds it at the end of that display's bar).
    static func addTarget(_ displays: [[String: Any]], screen: Int) -> Result<SpaceButton, DesktopAdminError> {
        let order = screenOrder(DesktopList.parse(displays, mainDisplayId: nil))
        guard screen >= 1, screen <= order.count,
              let index = displays.firstIndex(where: { ($0["Display Identifier"] as? String ?? "") == order[screen - 1] }) else {
            return .failure(.noSuchScreen(screen))
        }
        let count = spaceIds(displays[index]).count
        return .success(SpaceButton(displayIndex: index, displayId: order[screen - 1], buttonIndex: count, buttonCount: count))
    }

    /// Another desktop on the same screen to stand on while closing `number`: the one before it, else the one after.
    static func stepAside(from number: Int, in desktops: [Desktop]) -> Int? {
        guard let d = desktops.first(where: { $0.number == number }) else { return nil }
        let same = desktops.filter { $0.displayId == d.displayId && $0.number != number }
        return same.last(where: { $0.number < number })?.number ?? same.first?.number
    }

    static func isGone(_ displays: [[String: Any]], space: UInt64) -> Bool {
        !displays.contains { spaceIds($0).contains(space) }
    }

    /// Desktops (not fullscreen spaces) on one display.
    static func desktopCount(_ displays: [[String: Any]], displayId: String) -> Int {
        DesktopList.parse(displays, mainDisplayId: nil).filter { $0.displayId == displayId }.count
    }

    /// The Mission Control display group covering `screen` the most; nil when none overlaps it.
    static func matchDisplay(frames: [Rect?], screen: Rect) -> Int? {
        var best: (index: Int, area: Double)?
        for (i, frame) in frames.enumerated() {
            guard let f = frame else { continue }
            let w = min(f.maxX, screen.maxX) - max(f.x, screen.x)
            let h = min(f.maxY, screen.maxY) - max(f.y, screen.y)
            guard w > 0, h > 0, w * h > (best?.area ?? 0) else { continue }
            best = (i, w * h)
        }
        return best?.index
    }

    /// Every space on a display, fullscreen ones included, in Mission Control order.
    private static func spaceIds(_ display: [String: Any]) -> [UInt64] {
        (display["Spaces"] as? [[String: Any]] ?? []).compactMap { ($0["ManagedSpaceID"] as? NSNumber)?.uint64Value }
    }
}
