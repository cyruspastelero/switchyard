import Foundation
import XCTest
@testable import Switchyard

final class MenuPanelTests: XCTestCase {
    private func context(_ name: String, key: Int?, status: String, windows: Int) -> ContextDTO {
        ContextDTO(id: name.lowercased(), name: name, key: key, color: nil, status: status,
                   windows: (0..<windows).map { WindowRef(key: "w\($0)") })
    }

    func test_row_label_names_status_windows_and_key() {
        let tala = context("Tala", key: 2, status: "waiting", windows: 3)
        XCTAssertEqual(MenuPanelLogic.accessibilityLabel(tala), "Tala, waiting on you, 3 windows, Option 2")
    }

    func test_row_label_uses_singular_window_and_skips_a_missing_key() {
        let notes = context("Notes", key: nil, status: "idle", windows: 1)
        XCTAssertEqual(MenuPanelLogic.accessibilityLabel(notes), "Notes, idle, 1 window")
    }

    func test_row_detail_shows_status_and_window_count() {
        XCTAssertEqual(MenuPanelLogic.detail(context("A", key: 1, status: "working", windows: 0)), "working · 0 windows")
        XCTAssertEqual(MenuPanelLogic.detail(context("A", key: 1, status: "parked", windows: 1)), "parked · 1 window")
    }

    func test_shortcut_text_is_option_and_key_or_nothing() {
        XCTAssertEqual(MenuPanelLogic.shortcut(context("A", key: 4, status: "idle", windows: 0)), "⌥4")
        XCTAssertNil(MenuPanelLogic.shortcut(context("A", key: nil, status: "idle", windows: 0)))
    }

    func test_moving_down_from_no_selection_picks_the_first_row() {
        XCTAssertEqual(MenuPanelLogic.move(selection: nil, by: 1, count: 3), 0)
    }

    func test_moving_up_from_no_selection_picks_the_last_row() {
        XCTAssertEqual(MenuPanelLogic.move(selection: nil, by: -1, count: 3), 2)
    }

    func test_moving_past_either_end_wraps_like_the_switcher() {
        XCTAssertEqual(MenuPanelLogic.move(selection: 2, by: 1, count: 3), 0)
        XCTAssertEqual(MenuPanelLogic.move(selection: 0, by: -1, count: 3), 2)
        XCTAssertEqual(MenuPanelLogic.move(selection: 1, by: 1, count: 3), 2)
    }

    func test_moving_with_no_rows_clears_the_selection() {
        XCTAssertNil(MenuPanelLogic.move(selection: 1, by: 1, count: 0))
    }

    func test_return_picks_the_selected_row_or_else_the_top_match() {
        let rows = [context("A", key: 1, status: "idle", windows: 0), context("B", key: 2, status: "idle", windows: 0)]
        XCTAssertEqual(MenuPanelLogic.pick(rows: rows, selection: 1), "b")
        XCTAssertEqual(MenuPanelLogic.pick(rows: rows, selection: nil), "a")
        XCTAssertEqual(MenuPanelLogic.pick(rows: rows, selection: 7), "a")
        XCTAssertNil(MenuPanelLogic.pick(rows: [], selection: nil))
    }

    func test_visible_rows_filter_like_the_switcher() {
        let rows = [context("Tala", key: 1, status: "waiting", windows: 0), context("Basa", key: 2, status: "idle", windows: 0)]
        XCTAssertEqual(MenuPanelLogic.visibleRows(rows, query: "wait").map(\.name), ["Tala"])
        XCTAssertEqual(MenuPanelLogic.visibleRows(rows, query: "").map(\.name), ["Tala", "Basa"])
        XCTAssertEqual(MenuPanelLogic.visibleRows(rows, query: "2").map(\.name), ["Basa"])
    }

    func test_status_tone_maps_each_status() {
        XCTAssertEqual(MenuPanelLogic.tone("working"), .working)
        XCTAssertEqual(MenuPanelLogic.tone("waiting"), .waiting)
        XCTAssertEqual(MenuPanelLogic.tone("idle"), .idle)
        XCTAssertEqual(MenuPanelLogic.tone("parked"), .parked)
        XCTAssertEqual(MenuPanelLogic.tone("something new"), .idle)
    }

    func test_unsorted_row_is_hidden_at_zero_and_counts_windows() {
        XCTAssertNil(MenuPanelLogic.unsortedText(0))
        XCTAssertEqual(MenuPanelLogic.unsortedText(1), "1 unsorted window")
        XCTAssertEqual(MenuPanelLogic.unsortedText(4), "4 unsorted windows")
    }

    func test_health_is_ok_only_when_the_server_is_up_and_access_is_granted() {
        XCTAssertEqual(MenuPanelLogic.health(serverProblem: nil, trusted: true), .ok)
        XCTAssertEqual(MenuPanelLogic.health(serverProblem: "Server not reachable", trusted: true),
                       .problem("Server not reachable", fix: .command("switchyard install-service")))
        XCTAssertEqual(MenuPanelLogic.health(serverProblem: nil, trusted: false),
                       .problem("Windows can't be moved yet", fix: .allowAccessibility))
        XCTAssertEqual(MenuPanelLogic.health(serverProblem: "Down", trusted: false),
                       .problem("Down", fix: .command("switchyard install-service")))
    }

    func test_server_fix_runs_the_copy_bundled_in_the_app() {
        let entry = "/Applications/Switchyard.app/Contents/Resources/server/src/index.ts"
        let command = MenuStatus.startCommand(bundledEntry: entry)
        XCTAssertEqual(command, #"node "/Applications/Switchyard.app/Contents/Resources/server/src/index.ts" install-service"#)
        XCTAssertEqual(MenuPanelLogic.health(serverProblem: "Server not reachable", trusted: true, startCommand: command),
                       .problem("Server not reachable", fix: .command(command)))
    }

    func test_server_fix_without_a_bundled_copy_uses_the_cli() {
        XCTAssertEqual(MenuStatus.startCommand(bundledEntry: nil), "switchyard install-service")
    }

    func test_header_dot_label_says_whether_switchyard_is_ready() {
        XCTAssertEqual(MenuPanelLogic.healthLabel(.ok), "Switchyard is running")
        XCTAssertEqual(MenuPanelLogic.healthLabel(.problem("Down", fix: .allowAccessibility)), "Switchyard needs attention")
    }
}
