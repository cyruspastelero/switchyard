import Carbon.HIToolbox
import Foundation

/// Global hotkeys through Carbon RegisterEventHotKey (no Accessibility permission needed).
final class HotkeyCenter {
    static let shared = HotkeyCenter()

    /// Key codes for 1...9 on an ANSI keyboard (they are not sequential).
    static let digitKeyCodes: [UInt32] = [18, 19, 20, 21, 23, 22, 26, 28, 25]
    static let spaceKeyCode: UInt32 = 49
    /// ⌥T: tidy this desktop.
    static let tidyKeyCode: UInt32 = 17

    private var actions: [UInt32: (Date) -> Void] = [:]
    private var refs: [EventHotKeyRef] = []
    private var nextId: UInt32 = 1
    private var handlerInstalled = false

    /// Registers Option + key. Returns false if another app owns the combination.
    /// The action gets the time the key press reached this app, for the switch timing log.
    @discardableResult
    func registerOption(keyCode: UInt32, action: @escaping (Date) -> Void) -> Bool {
        installHandlerIfNeeded()
        let id = nextId; nextId += 1
        var ref: EventHotKeyRef?
        let hotKeyID = EventHotKeyID(signature: OSType(0x53595744), id: id) // 'SYWD'
        let status = RegisterEventHotKey(keyCode, UInt32(optionKey), hotKeyID, GetApplicationEventTarget(), 0, &ref)
        guard status == noErr, let ref else {
            Log.app.error("hotkey registration failed for key code \(keyCode, privacy: .public) (status \(status, privacy: .public))")
            return false
        }
        refs.append(ref)
        actions[id] = action
        return true
    }

    func unregisterAll() {
        refs.forEach { UnregisterEventHotKey($0) }
        refs.removeAll(); actions.removeAll()
    }

    fileprivate func fire(_ id: UInt32) {
        let pressed = Date()
        DispatchQueue.main.async { [weak self] in self?.actions[id]?(pressed) }
    }

    private func installHandlerIfNeeded() {
        guard !handlerInstalled else { return }
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let status = InstallEventHandler(GetApplicationEventTarget(), { _, event, _ -> OSStatus in
            var hk = EventHotKeyID()
            let got = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                                        nil, MemoryLayout<EventHotKeyID>.size, nil, &hk)
            if got == noErr { HotkeyCenter.shared.fire(hk.id) }
            return noErr
        }, 1, &spec, nil, nil)
        if status == noErr { handlerInstalled = true } else {
            Log.app.error("InstallEventHandler failed (status \(status, privacy: .public))")
        }
    }
}
