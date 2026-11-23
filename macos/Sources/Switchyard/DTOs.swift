import CryptoKit
import Foundation

// All wire shapes live in this file. Adjust here when the server API changes.

// MARK: - Snapshot (app -> server)

struct BrowserTab: Codable, Equatable {
    let id: String
    let url: String
    let title: String
}

struct BrowserBlock: Codable, Equatable {
    let windowId: String
    let name: String?
    let tabs: [BrowserTab]
    /// A named Chrome window shows its name as the window title, so the page it shows comes from here.
    var activeTitle: String? = nil

    private enum CodingKeys: String, CodingKey { case windowId, name, tabs, activeTitle }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(windowId, forKey: .windowId)
        try c.encode(name, forKey: .name) // explicit null, as the design shows `name|null`
        try c.encode(tabs, forKey: .tabs)
        try c.encodeIfPresent(activeTitle, forKey: .activeTitle)
    }
}

/// One window in the snapshot. The frame is deliberately not part of it
/// (the design has no frame field and the server rejects unknown fields).
struct WindowSnapshot: Codable, Equatable {
    let key: String
    let app: String
    let bundleId: String
    let pid: Int32
    let title: String
    let document: String?
    let browser: BrowserBlock?
    /// Desktop number, counted across displays as Ctrl+N does; nil when fullscreen, minimized or on all desktops.
    let desktop: Int?
    /// Native tab titles of a terminal window with two or more tabs, in tab-bar order. Not sent when nil.
    let tabTitles: [String]?

    private enum CodingKeys: String, CodingKey { case key, app, bundleId, pid, title, document, browser, desktop, tabTitles }

    init(key: String, app: String, bundleId: String, pid: Int32, title: String, document: String?, browser: BrowserBlock?,
         desktop: Int? = nil, tabTitles: [String]? = nil) {
        self.key = key; self.app = app; self.bundleId = bundleId; self.pid = pid; self.title = title
        self.document = document; self.browser = browser; self.desktop = desktop; self.tabTitles = tabTitles
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(key, forKey: .key)
        try c.encode(app, forKey: .app)
        try c.encode(bundleId, forKey: .bundleId)
        try c.encode(pid, forKey: .pid)
        try c.encode(title, forKey: .title)
        try c.encode(document, forKey: .document)
        try c.encode(browser, forKey: .browser)
        try c.encode(desktop, forKey: .desktop)
        try c.encodeIfPresent(tabTitles, forKey: .tabTitles)
    }
}

struct DesktopsInfo: Codable, Equatable {
    let count: Int
    let active: Int?

    private enum CodingKeys: String, CodingKey { case count, active }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(count, forKey: .count)
        try c.encode(active, forKey: .active)
    }
}

struct SnapshotBody: Codable, Equatable {
    let windows: [WindowSnapshot]
    /// nil (sent as null) when the desktops can't be read: the server then hides windows off-screen.
    let desktops: DesktopsInfo?
    /// False once every carry of a sort failed.
    let canCarry: Bool

    private enum CodingKeys: String, CodingKey { case windows, desktops, canCarry }

    init(windows: [WindowSnapshot], desktops: DesktopsInfo? = nil, canCarry: Bool = true) {
        self.windows = windows; self.desktops = desktops; self.canCarry = canCarry
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(windows, forKey: .windows)
        try c.encode(desktops, forKey: .desktops)
        try c.encode(canCarry, forKey: .canCarry)
    }

    /// Stable hash used to decide whether the snapshot changed.
    func fingerprint() -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(self) else { return UUID().uuidString }
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

// MARK: - Contexts (server -> app)

/// Ids may arrive as strings or numbers.
struct FlexString: Decodable, Equatable {
    let value: String

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self) { value = s; return }
        if let i = try? c.decode(Int.self) { value = String(i); return }
        if let d = try? c.decode(Double.self) { value = String(Int(d)); return }
        throw DecodingError.typeMismatch(String.self, .init(codingPath: decoder.codingPath, debugDescription: "id is not a string or number"))
    }
}

struct WindowRef: Decodable, Equatable {
    let key: String
    /// The desktop the window is on; nil when unknown (off-screen mode, minimized, fullscreen, an older server).
    let desktop: Int?

    private enum CodingKeys: String, CodingKey { case key, desktop }

    init(key: String, desktop: Int? = nil) { self.key = key; self.desktop = desktop }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        desktop = try? c.decode(Int.self, forKey: .desktop)
    }
}

struct ContextDTO: Decodable, Equatable, Identifiable {
    let id: String
    let name: String
    let key: Int?
    let color: String?
    let status: String
    let windows: [WindowRef]
    /// The desktop the context lives on; nil in off-screen mode.
    let desktop: Int?
    /// The last desktop, shared with unsorted windows and other contexts.
    let desktopShared: Bool
    /// Its windows known to sit on another desktop.
    let strays: Int

    private enum CodingKeys: String, CodingKey { case id, name, key, color, status, windows, desktop, desktopShared, strays }

    init(id: String, name: String, key: Int?, color: String?, status: String, windows: [WindowRef] = [],
         desktop: Int? = nil, desktopShared: Bool = false, strays: Int = 0) {
        self.id = id; self.name = name; self.key = key; self.color = color; self.status = status; self.windows = windows
        self.desktop = desktop; self.desktopShared = desktopShared; self.strays = strays
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(FlexString.self, forKey: .id).value
        name = try c.decode(String.self, forKey: .name)
        key = try? c.decode(Int.self, forKey: .key)
        color = try? c.decode(String.self, forKey: .color)
        status = (try? c.decode(String.self, forKey: .status)) ?? "idle"
        windows = (try? c.decode([WindowRef].self, forKey: .windows)) ?? []
        desktop = try? c.decode(Int.self, forKey: .desktop)
        desktopShared = (try? c.decode(Bool.self, forKey: .desktopShared)) ?? false
        strays = (try? c.decode(Int.self, forKey: .strays)) ?? 0
    }
}

struct ContextsResponse: Decodable, Equatable {
    let windowControl: Bool
    let activeContextId: String?
    let contexts: [ContextDTO]
    let waitingCount: Int
    /// Windows that belong to no context.
    let unsorted: [WindowRef]
    var unsortedCount: Int { unsorted.count }
    /// Unsorted windows that Sort would carry off project desktops.
    let unsortedToMove: Int
    /// Sort and Move lay out the desktops they change.
    let autoTidy: Bool
    /// Sorted windows on the wrong desktop.
    let toSort: Int
    /// True when the server uses real desktops.
    let desktopMode: Bool

    private enum CodingKeys: String, CodingKey { case windowControl, activeContextId, contexts, waitingCount, unsorted, toSort, desktopMode, unsortedToMove, autoTidy }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        windowControl = (try? c.decode(Bool.self, forKey: .windowControl)) ?? false
        activeContextId = try? c.decode(FlexString.self, forKey: .activeContextId).value
        let list = try c.decode([ContextDTO].self, forKey: .contexts)
        contexts = list
        waitingCount = (try? c.decode(Int.self, forKey: .waitingCount)) ?? list.filter { $0.status == "waiting" }.count
        unsorted = (try? c.decode([WindowRef].self, forKey: .unsorted)) ?? []
        unsortedToMove = (try? c.decode(Int.self, forKey: .unsortedToMove)) ?? 0
        autoTidy = (try? c.decode(Bool.self, forKey: .autoTidy)) ?? true
        toSort = (try? c.decode(Int.self, forKey: .toSort)) ?? 0
        desktopMode = (try? c.decode(String.self, forKey: .desktopMode)) == "desktops"
    }
}

// MARK: - Commands (server -> app)

struct WindowMoveDTO: Decodable, Equatable {
    let windowKey: String
    let desktop: Int
}

/// One tab a `splitTabs` pulls out: its place in the tab bar when the server decided, and its title.
struct TabRefDTO: Decodable, Equatable {
    let index: Int
    let title: String
}

/// The tabs of one window that belong to another project.
struct TabSplitDTO: Decodable, Equatable {
    let windowKey: String
    let tabs: [TabRefDTO]
}

/// One desktop of a `tidy` command and the windows to lay out on it.
struct TidyDesktopDTO: Decodable, Equatable {
    let desktop: Int
    let windowKeys: [String]
}

/// Command types: show, moveWindows, tidy, nameWindow, openWindow, closeWindow, openTab, closeTab, showAll, splitTabs.
/// Fields are read from the top level, or from a nested `payload` object if present.
struct AppCommand: Decodable, Equatable {
    let seq: Int
    let type: String
    let contextId: String?
    let windowKey: String?
    let windowKeys: [String]
    /// `show` only: windows of other contexts. nil when the server did not send it.
    let hideKeys: [String]?
    /// `show` only: false re-applies the context without raising or focusing anything.
    let focus: Bool
    /// `show` with real desktops: the desktop to go to first.
    let desktop: Int?
    /// `show` only: windows of the context on another desktop. Never raised, hidden or moved; for the hint only.
    let strayKeys: [String]
    /// `moveWindows` only.
    let moves: [WindowMoveDTO]
    /// `moveWindows`: desktops to tidy after the carries.
    let tidy: [Int]
    /// `tidy` only.
    let tidyDesktops: [TidyDesktopDTO]
    /// `splitTabs` only.
    let splits: [TabSplitDTO]
    /// `tidy`: true for an explicit Tidy; false skips a desktop whose window set did not change.
    let force: Bool
    let name: String?
    let browser: String?
    let urls: [String]
    let url: String?
    let tabId: String?
    /// When the server queued it. Only used to log how long a command waited.
    let createdAt: Date?

    private enum K: String, CodingKey {
        case seq, type, createdAt, payload, contextId, windowKey, windowKeys, hideKeys, strayKeys, focus, desktop, moves, tidy, desktops, force
        case splits
        case name, browser, urls, url, tabId
    }

    init(from decoder: Decoder) throws {
        let top = try decoder.container(keyedBy: K.self)
        seq = try top.decode(Int.self, forKey: .seq)
        type = try top.decode(String.self, forKey: .type)
        createdAt = (try? top.decode(String.self, forKey: .createdAt)).flatMap(Self.parseDate)
        let c = (try? top.nestedContainer(keyedBy: K.self, forKey: .payload)) ?? top
        contextId = Self.flex(c, .contextId)
        windowKey = try? c.decode(String.self, forKey: .windowKey)
        windowKeys = (try? c.decode([String].self, forKey: .windowKeys)) ?? []
        hideKeys = try? c.decode([String].self, forKey: .hideKeys)
        focus = (try? c.decode(Bool.self, forKey: .focus)) ?? true
        desktop = try? c.decode(Int.self, forKey: .desktop)
        strayKeys = (try? c.decode([String].self, forKey: .strayKeys)) ?? []
        moves = (try? c.decode([WindowMoveDTO].self, forKey: .moves)) ?? []
        tidy = (try? c.decode([Int].self, forKey: .tidy)) ?? []
        tidyDesktops = (try? c.decode([TidyDesktopDTO].self, forKey: .desktops)) ?? []
        splits = (try? c.decode([TabSplitDTO].self, forKey: .splits)) ?? []
        force = (try? c.decode(Bool.self, forKey: .force)) ?? false
        name = try? c.decode(String.self, forKey: .name)
        browser = try? c.decode(String.self, forKey: .browser)
        urls = (try? c.decode([String].self, forKey: .urls)) ?? []
        url = try? c.decode(String.self, forKey: .url)
        tabId = Self.flex(c, .tabId)
    }

    private static func parseDate(_ text: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: text)
    }

    private static func flex(_ c: KeyedDecodingContainer<K>, _ key: K) -> String? {
        try? c.decode(FlexString.self, forKey: key).value
    }
}

/// The commands endpoint may return a bare array or `{ commands: [...] }`.
struct CommandsEnvelope: Decodable {
    let commands: [AppCommand]
    /// Highest sequence number the server has issued; used to start polling "from now".
    let lastSeq: Int?

    init(from decoder: Decoder) throws {
        if let list = try? [AppCommand](from: decoder) { commands = list; lastSeq = nil; return }
        let c = try decoder.container(keyedBy: CodingKeys.self)
        commands = try c.decode([AppCommand].self, forKey: .commands)
        lastSeq = try c.decodeIfPresent(Int.self, forKey: .lastSeq)
    }

    private enum CodingKeys: String, CodingKey { case commands, lastSeq }
}

struct AckBody: Encodable {
    let ok: Bool
    let error: String?
    /// `moveWindows`: the windows that could not be carried.
    let failedKeys: [String]
}

struct AccessCodeResponse: Decodable {
    let accessCode: String
}
