import AppKit
import CoreGraphics

// "Switch to Desktop N" (Ctrl+N by default). The shortcuts can be off in System Settings; the app turns the
// ones it needs on for the length of one command and puts them back. A crash in between is undone at next launch.

@_silgen_name("CGSIsSymbolicHotKeyEnabled") private func cgsIsHotKeyEnabled(_ id: Int32) -> Bool
@_silgen_name("CGSSetSymbolicHotKeyEnabled") private func cgsSetHotKeyEnabled(_ id: Int32, _ enabled: Bool) -> Int32
@_silgen_name("CGSGetSymbolicHotKeyValue")
private func cgsHotKeyValue(_ id: Int32, _ character: UnsafeMutablePointer<UInt16>,
                            _ keyCode: UnsafeMutablePointer<UInt16>, _ modifiers: UnsafeMutablePointer<UInt32>) -> Int32

struct DesktopShortcut: Equatable {
    let desktop: Int
    let hotKeyId: Int32
    let keyCode: CGKeyCode
    let modifiers: UInt32
    var flags: CGEventFlags { DesktopKeys.flags(fromSymbolicModifiers: modifiers) }
}

enum DesktopError: Error, LocalizedError, Equatable {
    case noShortcut(Int)
    case switchTimeout(Int)
    case noSuchDesktop(Int)
    case aborted(String)

    var errorDescription: String? {
        switch self {
        case .noShortcut(let n): return "no Switch to Desktop \(n) shortcut"
        case .switchTimeout(let n): return "the switch to Desktop \(n) did not happen within \(CarryDelays.switchTimeout) s"
        case .noSuchDesktop(let n): return "Desktop \(n) does not exist"
        case .aborted(let why): return "stopped: \(why)"
        }
    }
}

enum DesktopKeys {
    static let maxDesktop = 16

    /// Symbolic hotkey id of "Switch to Desktop N" (118 is Desktop 1).
    static func hotKeyId(forDesktop number: Int) -> Int32? {
        (1...maxDesktop).contains(number) ? Int32(117 + number) : nil
    }

    /// Maps the modifier mask `CGSGetSymbolicHotKeyValue` reports (NSEvent bit layout) to event flags.
    /// The fn bit also sets numeric pad, as real arrow and function key events carry both.
    static func flags(fromSymbolicModifiers mask: UInt32) -> CGEventFlags {
        var flags: CGEventFlags = []
        if mask & 0x20000 != 0 { flags.insert(.maskShift) }
        if mask & 0x40000 != 0 { flags.insert(.maskControl) }
        if mask & 0x80000 != 0 { flags.insert(.maskAlternate) }
        if mask & 0x100000 != 0 { flags.insert(.maskCommand) }
        if mask & 0x200000 != 0 { flags.insert(.maskNumericPad) }
        if mask & 0x800000 != 0 { flags.insert([.maskSecondaryFn, .maskNumericPad]) }
        return flags
    }

    /// The key the system reports for the desktop, even while the shortcut is off.
    static func shortcut(for number: Int) -> DesktopShortcut? {
        guard let id = hotKeyId(forDesktop: number) else { return nil }
        var character: UInt16 = 0, keyCode: UInt16 = 0, modifiers: UInt32 = 0
        guard cgsHotKeyValue(id, &character, &keyCode, &modifiers) == 0, keyCode != 0xFFFF else { return nil }
        return DesktopShortcut(desktop: number, hotKeyId: id, keyCode: CGKeyCode(keyCode), modifiers: modifiers)
    }

    static func isEnabled(_ id: Int32) -> Bool { cgsIsHotKeyEnabled(id) }

    @discardableResult
    static func setEnabled(_ id: Int32, _ enabled: Bool) -> Bool { cgsSetHotKeyEnabled(id, enabled) == 0 }

    static func post(_ shortcut: DesktopShortcut) {
        let source = CGEventSource(stateID: .hidSystemState)
        for down in [true, false] {
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: shortcut.keyCode, keyDown: down) else { continue }
            event.flags = shortcut.flags // exactly these, so a physically held ⌥ does not change the shortcut
            event.post(tap: .cghidEventTap)
        }
    }

    /// Turns off what a crashed run left on. Called once at launch.
    static func undoLeftovers(file: HotKeyRestoreFile = HotKeyRestoreFile()) {
        let ids = file.load()
        for id in ids where isEnabled(id) { setEnabled(id, false) }
        if !ids.isEmpty {
            Log.windows.notice("turned \(ids.count, privacy: .public) desktop shortcuts back off after an unclean exit")
            file.save([])
        }
    }
}

/// Shortcuts turned on for one command. Each `acquire` is paired with a `release`; the last release
/// (or `releaseAll` on quit) turns them back off, so a local switch and a server command can overlap.
final class HotKeyLease: @unchecked Sendable {
    static let shared = HotKeyLease()

    private let lock = NSLock()
    private var turnedOn: [Int32] = []
    private var holders = 0
    private let file: HotKeyRestoreFile

    init(file: HotKeyRestoreFile = HotKeyRestoreFile()) { self.file = file }

    /// Returns the shortcuts, or throws when one is not reported. Waits briefly when one had to be turned on.
    func acquire(_ numbers: [Int]) throws -> [Int: DesktopShortcut] {
        var shortcuts: [Int: DesktopShortcut] = [:]
        var changed = false
        lock.lock(); holders += 1; lock.unlock()
        for n in Set(numbers) {
            guard let s = DesktopKeys.shortcut(for: n) else { release(); throw DesktopError.noShortcut(n) }
            shortcuts[n] = s
            if !DesktopKeys.isEnabled(s.hotKeyId) {
                lock.lock(); turnedOn.append(s.hotKeyId); let ids = turnedOn; lock.unlock()
                file.save(ids) // before turning it on, so a crash right after is undone
                DesktopKeys.setEnabled(s.hotKeyId, true)
                changed = true
            }
        }
        if changed { Thread.sleep(forTimeInterval: CarryDelays.afterHotKeyEnable) }
        return shortcuts
    }

    func release() {
        lock.lock()
        holders = max(0, holders - 1)
        let last = holders == 0
        lock.unlock()
        if last { releaseAll() }
    }

    func releaseAll() {
        lock.lock(); let ids = turnedOn; turnedOn = []; holders = 0; lock.unlock()
        for id in ids where DesktopKeys.isEnabled(id) {
            if !DesktopKeys.setEnabled(id, false) { Log.windows.error("could not turn desktop shortcut \(id, privacy: .public) back off") }
        }
        if !ids.isEmpty { file.save([]) }
    }
}

/// The ids of shortcuts the app turned on, so a crash is undone at the next launch.
struct HotKeyRestoreFile {
    let url: URL

    static var defaultURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("Switchyard/desktop-shortcuts-on.json")
    }

    init(url: URL = HotKeyRestoreFile.defaultURL) { self.url = url }

    func load() -> [Int32] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        do { return try JSONDecoder().decode([Int32].self, from: data) } catch {
            Log.windows.error("desktop-shortcuts-on.json is unreadable: \(error.localizedDescription, privacy: .public)")
            return []
        }
    }

    func save(_ ids: [Int32]) {
        do {
            if ids.isEmpty { try? FileManager.default.removeItem(at: url); return }
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(ids).write(to: url, options: .atomic)
        } catch {
            Log.windows.error("cannot save desktop-shortcuts-on.json: \(error.localizedDescription, privacy: .public)")
        }
    }
}

/// Goes to a desktop and waits until the system says it is there. Never re-presses: a missed switch fails.
enum DesktopSwitch {
    /// Blocking; call off the main thread. Returns milliseconds taken (0 when already there).
    @discardableResult
    static func go(to number: Int, shortcuts: [Int: DesktopShortcut], abort: () throws -> Void = {}) throws -> Int {
        let start = Date()
        let list = Spaces.desktops()
        guard let target = list.first(where: { $0.number == number }) else { throw DesktopError.noSuchDesktop(number) }
        if Spaces.isShowing(target.id) { return 0 }
        guard let key = shortcuts[number] else { throw DesktopError.noShortcut(number) }
        DesktopKeys.post(key)
        try wait(for: target.id, number: number, abort: abort)
        return Int(Date().timeIntervalSince(start) * 1000)
    }

    static func wait(for space: UInt64, number: Int, abort: () throws -> Void) throws {
        let end = Date().addingTimeInterval(CarryDelays.switchTimeout)
        while Date() < end {
            if Spaces.isShowing(space) { return }
            try abort()
            Thread.sleep(forTimeInterval: CarryDelays.switchPollInterval)
        }
        if !Spaces.isShowing(space) { throw DesktopError.switchTimeout(number) }
    }
}
