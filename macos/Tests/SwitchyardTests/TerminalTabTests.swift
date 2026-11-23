import Foundation
import XCTest
@testable import Switchyard

final class TerminalTabTests: XCTestCase {
    func test_tab_titles_come_from_the_tab_buttons_in_bar_order() {
        let children = [
            AXChild(role: "AXRadioButton", title: "~/aral"),
            AXChild(role: "AXButton", title: "New Tab"),
            AXChild(role: "AXRadioButton", title: "~/switchyard"),
        ]
        XCTAssertEqual(TerminalTabs.titles(children), ["~/aral", "~/switchyard"])
    }

    func test_a_single_tab_reports_no_titles() {
        XCTAssertEqual(TerminalTabs.titles([AXChild(role: "AXRadioButton", title: "~/aral")]), [])
    }

    func test_only_ghostty_windows_are_read_for_tabs() {
        XCTAssertTrue(TerminalTabs.reads(bundleId: "com.mitchellh.ghostty"))
        XCTAssertFalse(TerminalTabs.reads(bundleId: "com.google.Chrome"))
    }

    func test_a_repeated_tab_title_is_taken_from_the_source_windows_tab_bar() {
        let bars = [["✳ Claude Code", "~/aral"], ["~/tala", "✳ Claude Code"]]
        XCTAssertEqual(TerminalTabs.barIndex(holding: "✳ Claude Code", in: bars, source: ["~/tala", "✳ Claude Code"]), 1)
    }

    func test_a_repeated_tab_title_with_no_known_source_bar_is_not_guessed() {
        let bars = [["✳ Claude Code", "~/aral"], ["~/tala", "✳ Claude Code"]]
        XCTAssertNil(TerminalTabs.barIndex(holding: "✳ Claude Code", in: bars, source: ["~/x", "✳ Claude Code"]))
    }

    func test_a_tab_title_held_by_one_tab_bar_is_found_there() {
        XCTAssertEqual(TerminalTabs.barIndex(holding: "~/aral", in: [["a", "b"], ["~/aral", "c"]], source: []), 1)
        XCTAssertNil(TerminalTabs.barIndex(holding: "gone", in: [["a", "b"]], source: ["a", "b"]))
    }

    func test_the_source_bar_loses_each_tab_that_was_pulled_out() {
        XCTAssertEqual(TerminalTabs.remaining(["a", "b", "c"], after: TabRefDTO(index: 2, title: "c")), ["a", "b"])
        XCTAssertEqual(TerminalTabs.remaining(["a", "b", "b"], after: TabRefDTO(index: 9, title: "b")), ["a", "b"])
    }

    func test_a_tab_is_found_at_its_index_when_the_title_still_matches() {
        XCTAssertEqual(TerminalTabs.buttonIndex(for: TabRefDTO(index: 1, title: "b"), in: ["a", "b", "b"]), 1)
    }

    func test_a_tab_that_moved_is_found_by_its_title() {
        XCTAssertEqual(TerminalTabs.buttonIndex(for: TabRefDTO(index: 3, title: "b"), in: ["a", "b"]), 1)
        XCTAssertNil(TerminalTabs.buttonIndex(for: TabRefDTO(index: 0, title: "gone"), in: ["a", "b"]))
    }

    func test_tabs_are_pulled_out_from_the_right_so_earlier_indexes_stay_valid() {
        let order = TerminalTabs.splitOrder([TabRefDTO(index: 0, title: "a"), TabRefDTO(index: 3, title: "d")])
        XCTAssertEqual(order.map(\.index), [3, 0])
    }

    func test_the_move_tab_menu_item_is_recognised_by_its_title() {
        XCTAssertTrue(TerminalTabs.isMoveTabItem("Move Tab to New Window"))
        XCTAssertFalse(TerminalTabs.isMoveTabItem("Merge All Windows"))
    }

    func test_a_snapshot_sends_tab_titles_only_when_there_are_some() throws {
        let with = WindowSnapshot(key: "k", app: "Ghostty", bundleId: "b", pid: 1, title: "t", document: nil, browser: nil,
                                  desktop: 1, tabTitles: ["x", "y"])
        let without = WindowSnapshot(key: "k", app: "Ghostty", bundleId: "b", pid: 1, title: "t", document: nil, browser: nil)
        let a = try JSONSerialization.jsonObject(with: JSONEncoder().encode(with)) as? [String: Any]
        let b = try JSONSerialization.jsonObject(with: JSONEncoder().encode(without)) as? [String: Any]
        XCTAssertEqual(a?["tabTitles"] as? [String], ["x", "y"])
        XCTAssertNil(b?["tabTitles"])
    }

    func test_a_split_tabs_command_decodes_its_splits() throws {
        let json = #"{"seq":9,"type":"splitTabs","splits":[{"windowKey":"w1","tabs":[{"index":1,"title":"~/aral"}]}]}"#
        let cmd = try JSONDecoder().decode(AppCommand.self, from: Data(json.utf8))
        XCTAssertEqual(cmd.splits, [TabSplitDTO(windowKey: "w1", tabs: [TabRefDTO(index: 1, title: "~/aral")])])
    }
}
