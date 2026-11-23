import Foundation

/// Raw `make new` Apple Events for Chrome, addressed by pid. ScriptingBridge cannot make objects for an app
/// reached by pid: `class(forScriptingClass:)` returns a placeholder (`SBPseudoClass_…`) whose `alloc` is a
/// forwarding stub, so `make` failed every time (issue #12). A raw `core/crel` event works.
/// Codes come from Chrome's scripting.sdef: window `cwin`, tab `CrTb`, URL `URL `.
enum ChromeEvents {
    static let windowClass = "cwin"
    static let tabClass = "CrTb"

    static func code(_ s: String) -> FourCharCode { s.utf8.reduce(0) { ($0 << 8) | FourCharCode($1) } }

    /// The `make new` event. `container` puts the new object at the end of that object's elements.
    static func makeEvent(pid: pid_t, scriptingClass: String, container: NSAppleEventDescriptor?,
                          properties: [String: String]) -> NSAppleEventDescriptor {
        let event = NSAppleEventDescriptor(eventClass: code("core"), eventID: code("crel"),
                                           targetDescriptor: NSAppleEventDescriptor(processIdentifier: pid),
                                           returnID: AEReturnID(kAutoGenerateReturnID),
                                           transactionID: AETransactionID(kAnyTransactionID))
        event.setParam(NSAppleEventDescriptor(typeCode: code(scriptingClass)), forKeyword: code("kocl"))
        if let container, let location = endOf(container) { event.setParam(location, forKeyword: code("insh")) }
        if !properties.isEmpty {
            let record = NSAppleEventDescriptor.record()
            for (key, value) in properties { record.setDescriptor(NSAppleEventDescriptor(string: value), forKeyword: code(key)) }
            event.setParam(record, forKeyword: code("prdt"))
        }
        return event
    }

    /// `end of <container>` as an insertion location.
    static func endOf(_ container: NSAppleEventDescriptor) -> NSAppleEventDescriptor? {
        let location = NSAppleEventDescriptor.record()
        location.setDescriptor(container, forKeyword: code("kobj"))
        location.setDescriptor(NSAppleEventDescriptor(enumCode: code("end ")), forKeyword: code("kpos"))
        return location.coerce(toDescriptorType: code("insl"))
    }

    /// `window id N` as an object specifier.
    static func windowSpecifier(id: String) -> NSAppleEventDescriptor? {
        let spec = NSAppleEventDescriptor.record()
        spec.setDescriptor(NSAppleEventDescriptor.null(), forKeyword: code("from"))
        spec.setDescriptor(NSAppleEventDescriptor(typeCode: code(windowClass)), forKeyword: code("want"))
        spec.setDescriptor(NSAppleEventDescriptor(enumCode: code("ID  ")), forKeyword: code("form"))
        spec.setDescriptor(NSAppleEventDescriptor(string: id), forKeyword: code("seld"))
        return spec.coerce(toDescriptorType: code("obj "))
    }

    /// The id in a reply such as `window id "169299273"`; nil when the reply is not an id specifier.
    static func objectId(inReply reply: NSAppleEventDescriptor) -> String? {
        guard let spec = reply.paramDescriptor(forKeyword: code("----")), spec.descriptorType == code("obj "),
              spec.forKeyword(code("form"))?.enumCodeValue == code("ID  "),
              let seld = spec.forKeyword(code("seld")) else { return nil }
        if let s = seld.stringValue, !s.isEmpty { return s }
        return nil
    }

    /// The Apple Event error in a reply, if Chrome reported one.
    static func replyError(_ reply: NSAppleEventDescriptor) -> String? {
        guard let number = reply.paramDescriptor(forKeyword: code("errn"))?.int32Value, number != 0 else { return nil }
        let message = reply.paramDescriptor(forKeyword: code("errs"))?.stringValue
        return message.map { "\($0) (\(number))" } ?? "error \(number)"
    }

    /// Sends a `make new` and returns the new object's id. Blocks; call off the main thread.
    static func make(pid: pid_t, scriptingClass: String, container: NSAppleEventDescriptor?,
                     properties: [String: String], timeout: TimeInterval) throws -> String {
        let what = scriptingClass == windowClass ? "window" : "tab"
        let event = makeEvent(pid: pid, scriptingClass: scriptingClass, container: container, properties: properties)
        let reply: NSAppleEventDescriptor
        do {
            reply = try event.sendEvent(options: [.waitForReply], timeout: timeout)
        } catch {
            let code = (error as NSError).code
            if code == -1712 { throw BrowserError.unsupported("Chrome did not answer in time making a \(what)") }
            if code == -1743 {
                throw BrowserError.unsupported("Switchyard may not control Chrome: allow it in System Settings > Privacy & Security > Automation")
            }
            throw BrowserError.unsupported("Chrome refused to make a \(what): \(error.localizedDescription) (\(code))")
        }
        if let message = replyError(reply) { throw BrowserError.unsupported("Chrome refused to make a \(what): \(message)") }
        guard let id = objectId(inReply: reply) else { throw BrowserError.unsupported("Chrome made a \(what) but did not say which") }
        return id
    }
}
