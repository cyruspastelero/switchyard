import AppKit
import CoreGraphics

// Real macOS desktops (Spaces), read-only. Every call here works without Screen Recording.
// Private CGS calls link with plain AppKit.

@_silgen_name("CGSMainConnectionID") private func cgsMainConnection() -> Int32
@_silgen_name("CGSCopyManagedDisplaySpaces") private func cgsCopyManagedDisplaySpaces(_ connection: Int32) -> CFArray
@_silgen_name("CGSGetActiveSpace") private func cgsActiveSpace(_ connection: Int32) -> UInt64
@_silgen_name("CGSCopySpacesForWindows")
private func cgsCopySpacesForWindows(_ connection: Int32, _ mask: Int32, _ windowIds: CFArray) -> CFArray

/// One desktop (type-0 space). `number` is what Mission Control and Ctrl+N use, counted across displays.
struct Desktop: Equatable {
    let id: UInt64
    let number: Int
    let displayId: String
    let isMain: Bool
}

/// Pure parsing of `CGSCopyManagedDisplaySpaces`.
enum DesktopList {
    /// Fullscreen and tiled spaces are skipped. The main display is the one called "Main" or matching
    /// `mainDisplayId`; when none matches, the first display.
    static func parse(_ displays: [[String: Any]], mainDisplayId: String?) -> [Desktop] {
        let ids = displays.map { $0["Display Identifier"] as? String ?? "" }
        let mainIndex = mainDisplayIndex(ids, mainDisplayId: mainDisplayId)
        var result: [Desktop] = []
        for (index, display) in displays.enumerated() {
            for space in display["Spaces"] as? [[String: Any]] ?? [] {
                guard (space["type"] as? NSNumber)?.intValue == 0,
                      let id = (space["ManagedSpaceID"] as? NSNumber)?.uint64Value else { continue }
                result.append(Desktop(id: id, number: result.count + 1, displayId: ids[index], isMain: index == mainIndex))
            }
        }
        return result
    }

    /// The space the main display shows now, whichever display has focus. Nil without displays.
    static func currentMainSpace(_ displays: [[String: Any]], mainDisplayId: String?) -> UInt64? {
        guard !displays.isEmpty else { return nil }
        let ids = displays.map { $0["Display Identifier"] as? String ?? "" }
        let current = displays[mainDisplayIndex(ids, mainDisplayId: mainDisplayId)]["Current Space"] as? [String: Any]
        return (current?["ManagedSpaceID"] as? NSNumber)?.uint64Value
    }

    private static func mainDisplayIndex(_ ids: [String], mainDisplayId: String?) -> Int {
        ids.firstIndex { id in
            id == "Main" || (mainDisplayId.map { id.caseInsensitiveCompare($0) == .orderedSame } ?? false)
        } ?? 0
    }

    /// The desktop a window is on, on any display; nil for no space, several (All Desktops), or a non-desktop space.
    static func number(ofSpaces spaces: [UInt64], in desktops: [Desktop]) -> Int? {
        guard spaces.count == 1, let d = desktops.first(where: { $0.id == spaces[0] }) else { return nil }
        return d.number
    }

    /// The space each display shows now.
    static func currentSpaces(_ displays: [[String: Any]]) -> Set<UInt64> {
        Set(displays.compactMap { (($0["Current Space"] as? [String: Any])?["ManagedSpaceID"] as? NSNumber)?.uint64Value })
    }

    /// The desktop the person works on: the focused display's, else the main display's (focus on a fullscreen space).
    static func activeNumber(focused: UInt64, mainCurrent: UInt64?, in desktops: [Desktop]) -> Int? {
        number(ofSpaces: [focused], in: desktops) ?? mainCurrent.flatMap { number(ofSpaces: [$0], in: desktops) }
    }
}

/// System side: the live desktop list, the active desktop, each window's desktop.
enum Spaces {
    private static let connection = cgsMainConnection()
    private static let allSpacesMask: Int32 = 7

    private static func displays() -> [[String: Any]] {
        cgsCopyManagedDisplaySpaces(connection) as? [[String: Any]] ?? []
    }

    /// Every desktop, numbered across displays. Read live for every command: the owner may add or remove one.
    static func desktops() -> [Desktop] {
        DesktopList.parse(displays(), mainDisplayId: mainDisplayUUID())
    }

    static func mainDesktops() -> [Desktop] { desktops().filter(\.isMain) }

    /// The focused display's space (follows the pointer and key window across displays).
    static func activeSpace() -> UInt64 { cgsActiveSpace(connection) }

    /// True while any display shows the space. A switch to a desktop on another display may leave focus where it was.
    static func isShowing(_ space: UInt64) -> Bool { DesktopList.currentSpaces(displays()).contains(space) }

    /// True while some display shows desktop `number`.
    static func isShowingDesktop(_ number: Int, in list: [Desktop]? = nil) -> Bool {
        guard let d = (list ?? desktops()).first(where: { $0.number == number }) else { return false }
        return isShowing(d.id)
    }

    /// The focused display's desktop, else the main display's. Nil only when neither shows a desktop.
    static func activeDesktopNumber(in list: [Desktop]? = nil) -> Int? {
        let all = displays()
        return DesktopList.activeNumber(focused: activeSpace(),
                                        mainCurrent: DesktopList.currentMainSpace(all, mainDisplayId: mainDisplayUUID()),
                                        in: list ?? DesktopList.parse(all, mainDisplayId: mainDisplayUUID()))
    }

    /// The display a desktop is on, as `CGDirectDisplayID`. "Main" (one shared set of Spaces) is the main display.
    static func displayId(of desktop: Desktop) -> CGDirectDisplayID? {
        if desktop.displayId == "Main" { return CGMainDisplayID() }
        var count: UInt32 = 0
        var ids = [CGDirectDisplayID](repeating: 0, count: 16)
        guard CGGetActiveDisplayList(UInt32(ids.count), &ids, &count) == .success else { return nil }
        return ids.prefix(Int(count)).first { id in
            guard let uuid = CGDisplayCreateUUIDFromDisplayID(id)?.takeRetainedValue(),
                  let text = CFUUIDCreateString(nil, uuid) as String? else { return false }
            return text.caseInsensitiveCompare(desktop.displayId) == .orderedSame
        }
    }

    static func spaces(ofWindow id: UInt32) -> [UInt64] {
        let list = cgsCopySpacesForWindows(connection, allSpacesMask, [NSNumber(value: id)] as CFArray)
        return (list as? [NSNumber] ?? []).map(\.uint64Value)
    }

    static func desktopNumber(ofWindow id: UInt32, in list: [Desktop]) -> Int? {
        DesktopList.number(ofSpaces: spaces(ofWindow: id), in: list)
    }

    /// Window numbers the window server has right now, on every desktop. No Screen Recording needed for ids.
    static func aliveWindowIds() -> Set<UInt32> {
        let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
        return Set(list.compactMap { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value })
    }

    /// Window number -> position in the window server's order (0 is front-most), every desktop.
    static func zOrder() -> [UInt32: Int] {
        let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
        var order: [UInt32: Int] = [:]
        for (i, info) in list.enumerated() {
            guard let n = (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value, order[n] == nil else { continue }
            order[n] = i
        }
        return order
    }

    /// Where the window server has the window right now (Accessibility coordinates). No round trip to the app.
    static func bounds(ofWindow id: UInt32) -> Rect? {
        let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]]
        guard let dict = list?.first?[kCGWindowBounds as String] as? NSDictionary,
              let r = CGRect(dictionaryRepresentation: dict) else { return nil }
        return Rect(x: r.origin.x, y: r.origin.y, width: r.width, height: r.height)
    }

    /// Display frames in Accessibility coordinates. Safe off the main thread, unlike NSScreen.
    static func screenFrames() -> [Rect] {
        var count: UInt32 = 0
        var ids = [CGDirectDisplayID](repeating: 0, count: 16)
        guard CGGetActiveDisplayList(UInt32(ids.count), &ids, &count) == .success else { return [] }
        return ids.prefix(Int(count)).map { id in
            let b = CGDisplayBounds(id)
            return Rect(x: b.origin.x, y: b.origin.y, width: b.width, height: b.height)
        }
    }

    private static func mainDisplayUUID() -> String? {
        guard let uuid = CGDisplayCreateUUIDFromDisplayID(CGMainDisplayID())?.takeRetainedValue() else { return nil }
        return CFUUIDCreateString(nil, uuid) as String?
    }
}

/// Which previously seen windows to keep listing although Accessibility no longer returns them:
/// `kAXWindows` leaves out windows on other desktops. Pure.
enum DesktopMerge {
    /// Cached windows worth keeping for the next refresh: every one still alive, even when this refresh could not
    /// place it (no active desktop mid-switch). Dropping them would lose windows on other desktops until revisited.
    static func remembered(cached: [UInt32], alive: Set<UInt32>) -> [UInt32] {
        cached.filter { alive.contains($0) }
    }

    static func keep(cached: [UInt32], listed: Set<UInt32>, alive: Set<UInt32>, desktopOf: [UInt32: Int], active: Int?) -> [UInt32] {
        guard let active else { return [] }
        return cached.filter { id in
            guard !listed.contains(id), alive.contains(id), let d = desktopOf[id] else { return false }
            return d != active
        }
    }
}
