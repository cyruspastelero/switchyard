import Foundation
import XCTest
@testable import Switchyard

/// Restore opens windows with raw `make new` events because ScriptingBridge cannot make objects by pid (#12).
final class ChromeEventsTests: XCTestCase {
    private func c(_ s: String) -> FourCharCode { ChromeEvents.code(s) }

    func test_a_new_window_event_asks_chrome_to_make_a_window() {
        let event = ChromeEvents.makeEvent(pid: 4242, scriptingClass: ChromeEvents.windowClass, container: nil, properties: [:])
        XCTAssertEqual(event.eventClass, c("core"))
        XCTAssertEqual(event.eventID, c("crel"))
        XCTAssertEqual(event.paramDescriptor(forKeyword: c("kocl"))?.typeCodeValue, c("cwin"))
        XCTAssertNil(event.paramDescriptor(forKeyword: c("insh")))
        XCTAssertNil(event.paramDescriptor(forKeyword: c("prdt")))
    }

    func test_a_new_tab_goes_at_the_end_of_the_named_window_with_its_url() throws {
        let window = try XCTUnwrap(ChromeEvents.windowSpecifier(id: "169299273"))
        let event = ChromeEvents.makeEvent(pid: 4242, scriptingClass: ChromeEvents.tabClass, container: window,
                                           properties: ["URL ": "https://example.com/a"])
        XCTAssertEqual(event.paramDescriptor(forKeyword: c("kocl"))?.typeCodeValue, c("CrTb"))
        let location = try XCTUnwrap(event.paramDescriptor(forKeyword: c("insh")))
        XCTAssertEqual(location.descriptorType, c("insl"))
        XCTAssertEqual(location.forKeyword(c("kpos"))?.enumCodeValue, c("end "))
        XCTAssertEqual(location.forKeyword(c("kobj"))?.forKeyword(c("seld"))?.stringValue, "169299273")
        XCTAssertEqual(event.paramDescriptor(forKeyword: c("prdt"))?.forKeyword(c("URL "))?.stringValue, "https://example.com/a")
    }

    func test_the_new_window_id_is_read_from_chromes_reply() throws {
        let reply = NSAppleEventDescriptor.record()
        reply.setDescriptor(try XCTUnwrap(ChromeEvents.windowSpecifier(id: "777")), forKeyword: c("----"))
        XCTAssertEqual(ChromeEvents.objectId(inReply: reply), "777")
    }

    func test_a_reply_without_a_specifier_gives_no_id() {
        let reply = NSAppleEventDescriptor.record()
        reply.setDescriptor(NSAppleEventDescriptor(string: "ok"), forKeyword: c("----"))
        XCTAssertNil(ChromeEvents.objectId(inReply: reply))
    }

    func test_a_reply_error_names_chromes_message_and_number() {
        let reply = NSAppleEventDescriptor.record()
        reply.setDescriptor(NSAppleEventDescriptor(int32: -10000), forKeyword: c("errn"))
        reply.setDescriptor(NSAppleEventDescriptor(string: "Can't make window"), forKeyword: c("errs"))
        XCTAssertEqual(ChromeEvents.replyError(reply), "Can't make window (-10000)")
        XCTAssertNil(ChromeEvents.replyError(NSAppleEventDescriptor.record()))
    }
}
