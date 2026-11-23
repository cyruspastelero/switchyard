import Foundation

// Tidy: one layout by window count, no modes. Pure, so all of it is tested. Accessibility coordinates.

/// A window to lay out. `z`: 0 is front-most in the window server's order.
struct LayoutWindow: Equatable {
    let key: String
    let bundleId: String
    let z: Int
    let number: UInt32
}

/// A window's smallest size, learned from a tidy it would not shrink for.
struct Size: Equatable {
    let width: Double
    let height: Double
}

enum Layout {
    static let gap = 8.0
    static let mainShare = 0.6
    /// Each deck window sits this much lower than the one before, so every title bar shows.
    static let deckStep = 30.0
    /// The deck never squeezes a window below this height.
    static let minDeckHeight = 200.0

    /// The main window never gets less than this share, whatever the right column's windows need.
    static let minMainShare = 0.4

    /// Slot 0 is the main window (left). 1 fills; 2–4 stack the rest right; 5+ deck them in the right column.
    /// `minimums`: slot -> the smallest size that window takes. The right column widens and a stacked window
    /// grows to fit it, so nothing overlaps.
    static func frames(count: Int, area: Rect, gap: Double = gap, minimums: [Int: Size] = [:]) -> [Rect] {
        guard count > 0 else { return [] }
        let inner = Rect(x: area.x + gap, y: area.y + gap, width: area.width - 2 * gap, height: area.height - 2 * gap)
        guard count > 1 else { return [inner] }
        let shared = inner.width - gap
        let needed = (1..<count).compactMap { minimums[$0]?.width }.max() ?? 0
        let maxColumn = shared - (shared * minMainShare).rounded(.down)
        let columnWidth = min(max(shared - (shared * mainShare).rounded(), needed), maxColumn)
        let mainWidth = shared - columnWidth
        let main = Rect(x: inner.x, y: inner.y, width: mainWidth, height: inner.height)
        let column = Rect(x: main.maxX + gap, y: inner.y, width: columnWidth, height: inner.height)
        let rest = count - 1
        let minHeights = (1..<count).map { minimums[$0]?.height ?? 0 }
        // A stack whose windows cannot all get their minimum height would overlap anyway: deck them instead.
        let stackFits = minHeights.reduce(0, +) + gap * Double(rest - 1) <= column.height
        return [main] + (rest <= 3 && stackFits ? stack(rest, in: column, gap: gap, minHeights: minHeights) : deck(rest, in: column))
    }

    private static func stack(_ n: Int, in column: Rect, gap: Double, minHeights: [Double]) -> [Rect] {
        let total = column.height - gap * Double(n - 1)
        var fixed: [Int: Double] = [:]
        var share = (total / Double(n)).rounded(.down)
        // Windows that need more than an equal share get their minimum; the others split what is left.
        while true {
            let grow = (0..<n).filter { fixed[$0] == nil && minHeights[$0] > share }
            if grow.isEmpty { break }
            for i in grow { fixed[i] = minHeights[i] }
            let free = n - fixed.count
            guard free > 0 else { break }
            share = ((total - fixed.values.reduce(0, +)) / Double(free)).rounded(.down)
        }
        var y = column.y
        return (0..<n).map { i in
            let height = fixed[i] ?? share
            defer { y += height + gap }
            return Rect(x: column.x, y: y, width: column.width, height: height)
        }
    }

    /// Slot -> the size a window kept when it would not shrink to its slot (more than 2 px larger).
    static func minimums(slots: [Rect], got: [Rect]) -> [Int: Size] {
        var result: [Int: Size] = [:]
        for (i, (slot, g)) in zip(slots, got).enumerated() where g.width > slot.width + 2 || g.height > slot.height + 2 {
            result[i] = Size(width: max(g.width, slot.width), height: max(g.height, slot.height))
        }
        return result
    }

    /// Indexes of `new` slots that differ from `old` (or are new). Empty: another pass would change nothing.
    static func changedSlots(from old: [Rect], to new: [Rect]) -> [Int] {
        new.indices.filter { $0 >= old.count || old[$0] != new[$0] }
    }

    private static func deck(_ n: Int, in column: Rect) -> [Rect] {
        let step = min(deckStep, ((column.height - minDeckHeight) / Double(n - 1)).rounded(.down))
        return (0..<n).map { i in
            let y = column.y + Double(i) * step
            return Rect(x: column.x, y: y, width: column.width, height: column.maxY - y)
        }
    }

    /// The screen's `NSScreen.visibleFrame` (Cocoa, bottom-left origin) in Accessibility coordinates.
    static func area(visibleFrame: Rect, primaryHeight: Double) -> Rect {
        FrameMath.fromCocoa(visibleFrame, primaryHeight: primaryHeight)
    }

    /// Main first: the front-most browser window, else the front-most window. The rest front to back.
    /// Ties go by window number, so the same input always gives the same order.
    static func pickMain(_ windows: [LayoutWindow]) -> [String] {
        let ordered = windows.sorted { ($0.z, $0.number, $0.key) < ($1.z, $1.number, $1.key) }
        guard let main = ordered.first(where: { BrowserKind(rawValue: $0.bundleId) != nil }) ?? ordered.first else { return [] }
        return [main.key] + ordered.filter { $0.key != main.key }.map(\.key)
    }

    /// Where a window goes when it would not take its slot's size (minimum width, terminal cell grid):
    /// its own size, origin on the slot, pulled back so it does not hang off the area.
    static func fit(_ got: Rect, slot: Rect, area: Rect, gap: Double = gap) -> Rect {
        let x = max(area.x + gap, min(slot.x, area.maxX - gap - got.width))
        let y = max(area.y + gap, min(slot.y, area.maxY - gap - got.height))
        return Rect(x: x, y: y, width: got.width, height: got.height)
    }
}

/// Whether a tidy of one desktop runs.
enum TidyGate {
    /// From Sort or Move (`force` false) a desktop whose window set equals the one of its last tidy is left alone,
    /// so the owner's own resizes stay.
    /// A changed preset (or default) runs again too.
    static func shouldRun(keys: Set<String>, last: Set<String>?, force: Bool, preset: String = "", lastPreset: String = "") -> Bool {
        guard !keys.isEmpty else { return false }
        return force || last != keys || preset != lastPreset
    }

    /// Stable text for a preset's slots; "" for none.
    static func fingerprint(_ slots: [LayoutSlotDTO]?) -> String {
        guard let slots, !slots.isEmpty else { return "" }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return (try? encoder.encode(slots)).map { String(decoding: $0, as: UTF8.self) } ?? "?"
    }
}

/// Per desktop: the frames from before the last tidy (one Undo level) and the window set it laid out.
struct TidyMemory: Codable, Equatable {
    private var before: [String: [String: Rect]] = [:]
    private var sets: [String: [String]] = [:]
    /// The preset fingerprint of the last tidy; absent in files from before presets.
    private var presets: [String: String]? = nil
    /// The frames the last tidy left; absent in older files.
    private var after: [String: [String: Rect]]? = nil

    /// A tidy of the same windows, still where the last tidy left them, keeps the older Undo.
    mutating func record(desktop: Int, before frames: [String: Rect], keys: Set<String>, preset: String = "") {
        let d = String(desktop)
        if !Self.untouched(frames, since: after?[d]) || sets[d] != keys.sorted() { before[d] = frames }
        after?[d] = nil
        sets[d] = keys.sorted()
        presets = (presets ?? [:]).merging([d: preset]) { _, new in new }
    }

    /// The frames read back after a tidy's layout.
    mutating func recordResult(desktop: Int, after frames: [String: Rect]) {
        after = (after ?? [:]).merging([String(desktop): frames]) { _, new in new }
    }

    /// Same windows, each within 2 px of where the last tidy put it.
    private static func untouched(_ now: [String: Rect], since last: [String: Rect]?) -> Bool {
        guard let last, !last.isEmpty, Set(now.keys) == Set(last.keys) else { return false }
        return now.allSatisfy { key, f in
            guard let l = last[key] else { return false }
            return abs(f.x - l.x) <= 2 && abs(f.y - l.y) <= 2 && abs(f.width - l.width) <= 2 && abs(f.height - l.height) <= 2
        }
    }

    func lastPreset(desktop: Int) -> String { presets?[String(desktop)] ?? "" }

    func lastKeys(desktop: Int) -> Set<String>? { sets[String(desktop)].map(Set.init) }

    func canUndo(desktop: Int) -> Bool { !(before[String(desktop)] ?? [:]).isEmpty }

    /// The frames to put back. Cleared: there is one Undo level.
    mutating func takeUndo(desktop: Int) -> [String: Rect] {
        let frames = before[String(desktop)] ?? [:]
        before[String(desktop)] = nil
        sets[String(desktop)] = nil
        presets?[String(desktop)] = nil
        after?[String(desktop)] = nil
        return frames
    }
}

struct TidyStore {
    let url: URL

    static var defaultURL: URL {
        HiddenStore.defaultURL.deletingLastPathComponent().appendingPathComponent("tidy.json")
    }

    init(url: URL = TidyStore.defaultURL) { self.url = url }

    func load() -> TidyMemory {
        guard let data = try? Data(contentsOf: url) else { return TidyMemory() }
        do { return try JSONDecoder().decode(TidyMemory.self, from: data) } catch {
            Log.windows.error("tidy.json is unreadable: \(error.localizedDescription, privacy: .public)")
            return TidyMemory()
        }
    }

    func save(_ memory: TidyMemory) {
        do {
            try PrivateFile.write(try JSONEncoder().encode(memory), to: url)
        } catch {
            Log.windows.error("cannot save tidy.json: \(error.localizedDescription, privacy: .public)")
        }
    }
}

/// Which windows a desktop's tidy lays out, from the contexts the app holds.
enum TidyTargets {
    /// The preset of the context that owns the desktop (on the shared desktop, the active one), if it has one.
    static func slots(contexts: [ContextDTO], desktop: Int, activeContextId: String?) -> [LayoutSlotDTO]? {
        let here = contexts.filter { $0.desktop == desktop }
        let owner = here.contains(where: \.desktopShared) ? here.first { $0.id == activeContextId } : (here.count == 1 ? here.first : nil)
        guard let slots = owner?.layout?.slots, !slots.isEmpty else { return nil }
        return slots
    }

    /// The windows of the context(s) that own the desktop; on the shared desktop only the active context's.
    /// `moves`: windows just carried, which the contexts the app holds may not show yet.
    static func keys(contexts: [ContextDTO], desktop: Int, activeContextId: String?, moves: [WindowMoveDTO] = []) -> [String] {
        let here = contexts.filter { $0.desktop == desktop }
        let owners = here.contains(where: \.desktopShared) ? here.filter { $0.id == activeContextId } : here
        let movedAway = Set(moves.filter { $0.desktop != desktop }.map(\.windowKey))
        var keys = owners.flatMap { $0.windows.map(\.key) }.filter { !movedAway.contains($0) }
        for m in moves where m.desktop == desktop && !keys.contains(m.windowKey) { keys.append(m.windowKey) }
        return keys
    }
}

/// ⌥T and the panel's Tidy: every window the app holds that is not hidden off-screen, whatever its context.
/// The tidier keeps only those really on the desktop, so nothing is ever carried to another one.
enum ManualTidy {
    struct Candidate: Equatable {
        let key: String
        let hidden: Bool
    }

    static func keys(_ windows: [Candidate]) -> [String] {
        windows.filter { !$0.hidden }.map(\.key)
    }
}
