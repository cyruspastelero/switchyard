import Foundation
import XCTest
@testable import Switchyard

final class DTOTests: XCTestCase {
    private func decode<T: Decodable>(_ json: String, as type: T.Type = T.self) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    func test_contexts_response_decodes_design_shape() throws {
        let r: ContextsResponse = try decode("""
        {"windowControl":true,"activeContextId":"c1","waitingCount":2,"unsorted":[],"suggestions":[],
         "contexts":[{"id":"c1","name":"Tala","folder":null,"key":1,"color":"#aabbcc","status":"waiting",
           "agents":[{"id":"a","name":"x","status":"working","lastAction":"edit","costToday":null}],
           "windows":[{"key":"k1","app":"Ghostty","bundleId":"b","title":"t","name":null,"tabCount":null}],
           "parkedWindowCount":0,"lastActiveAt":1}]}
        """)
        XCTAssertEqual(r.waitingCount, 2)
        XCTAssertEqual(r.contexts.first?.windows.map(\.key), ["k1"])
        XCTAssertEqual(r.contexts.first?.key, 1)
    }

    func test_a_browser_block_sends_the_active_tab_title() throws {
        let block = BrowserBlock(windowId: "1", name: "aral", tabs: [], activeTitle: "Inbox")
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(block)) as? [String: Any]
        XCTAssertEqual(json?["activeTitle"] as? String, "Inbox")
    }

    func test_numeric_ids_decode_as_strings() throws {
        let r: ContextsResponse = try decode(#"{"contexts":[{"id":7,"name":"A","status":"idle"}]}"#)
        XCTAssertEqual(r.contexts.first?.id, "7")
        XCTAssertEqual(r.waitingCount, 0)
        XCTAssertFalse(r.windowControl)
    }

    func test_command_decodes_flat_and_nested_payload() throws {
        let flat: AppCommand = try decode(#"{"seq":3,"type":"show","contextId":"c","windowKeys":["a","b"]}"#)
        XCTAssertEqual(flat.windowKeys, ["a", "b"])
        let nested: AppCommand = try decode(#"{"seq":4,"type":"closeTab","payload":{"windowKey":"w","tabId":12}}"#)
        XCTAssertEqual(nested.windowKey, "w")
        XCTAssertEqual(nested.tabId, "12")
    }

    func test_unknown_command_type_still_decodes() throws {
        let c: AppCommand = try decode(#"{"seq":1,"type":"teleport"}"#)
        XCTAssertEqual(c.type, "teleport")
    }

    func test_commands_envelope_accepts_array_and_object() throws {
        let a: CommandsEnvelope = try decode(#"[{"seq":1,"type":"showAll"}]"#)
        let b: CommandsEnvelope = try decode(#"{"commands":[{"seq":2,"type":"showAll"}]}"#)
        XCTAssertEqual(a.commands.count, 1)
        XCTAssertEqual(b.commands.first?.seq, 2)
    }

    func test_snapshot_encodes_explicit_nulls_and_no_frame() throws {
        let body = SnapshotBody(windows: [WindowSnapshot(key: "k", app: "A", bundleId: "b", pid: 5, title: "t", document: nil, browser: nil)])
        let text = String(decoding: try JSONEncoder().encode(body), as: UTF8.self)
        XCTAssertTrue(text.contains("\"document\":null"))
        XCTAssertTrue(text.contains("\"browser\":null"))
        XCTAssertFalse(text.contains("frame"))
    }

    func test_fingerprint_changes_only_when_content_changes() {
        func w(_ t: String) -> SnapshotBody {
            SnapshotBody(windows: [WindowSnapshot(key: "k", app: "A", bundleId: "b", pid: 1, title: t, document: nil, browser: nil)])
        }
        XCTAssertEqual(w("x").fingerprint(), w("x").fingerprint())
        XCTAssertNotEqual(w("x").fingerprint(), w("y").fingerprint())
    }

    func test_browser_urls_reject_script_schemes() {
        XCTAssertNotNil(BrowserURL.sanitize("https://example.com/a"))
        XCTAssertNil(BrowserURL.sanitize("javascript:alert(1)"))
        XCTAssertNil(BrowserURL.sanitize("not a url"))
    }

    func test_context_filter_matches_every_word() {
        let cs = [ContextDTO(id: "1", name: "Tala", key: 1, color: nil, status: "waiting"),
                  ContextDTO(id: "2", name: "Arkitekto", key: 2, color: nil, status: "idle")]
        XCTAssertEqual(ContextFilter.filter(cs, query: "ark").map(\.id), ["2"])
        XCTAssertEqual(ContextFilter.filter(cs, query: "tala wait").map(\.id), ["1"])
        XCTAssertEqual(ContextFilter.filter(cs, query: "").count, 2)
    }
}
