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

    /// The main-display desktop a window is on; nil for no space, several (All Desktops), or a non-desktop space.
    static func number(ofSpaces spaces: [UInt64], in desktops: [Desktop]) -> Int? {
        guard spaces.count == 1, let d = desktops.first(where: { $0.id == spaces[0] }), d.isMain else { return nil }
        return d.number
    }
}

/// System side: the live desktop list, the active desktop, each window's desktop.
enum Spaces {
    private static let connection = cgsMainConnection()
    private static let allSpacesMask: Int32 = 7

    /// Every desktop, numbered across displays. Read live for every command: the owner may add or remove one.
    static func desktops() -> [Desktop] {
        let displays = cgsCopyManagedDisplaySpaces(connection) as? [[String: Any]] ?? []
        return DesktopList.parse(displays, mainDisplayId: mainDisplayUUID())
    }

    static func mainDesktops() -> [Desktop] { desktops().filter(\.isMain) }

    /// The main display's current space. Not `CGSGetActiveSpace`: that follows focus, so with focus on a
    /// second display it names a space no main-display command can use (issue #11).
    static func activeSpace() -> UInt64 {
        let displays = cgsCopyManagedDisplaySpaces(connection) as? [[String: Any]] ?? []
        return DesktopList.currentMainSpace(displays, mainDisplayId: mainDisplayUUID()) ?? cgsActiveSpace(connection)
    }

    /// Nil when the main display shows a fullscreen or other non-desktop space.
    static func activeDesktopNumber(in list: [Desktop]? = nil) -> Int? {
        DesktopList.number(ofSpaces: [activeSpace()], in: list ?? desktops())
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
