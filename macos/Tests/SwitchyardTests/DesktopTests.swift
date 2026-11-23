import CoreGraphics
import Foundation
import XCTest
@testable import Switchyard

final class DesktopTests: XCTestCase {
    private func space(_ id: UInt64, type: Int = 0) -> [String: Any] {
        ["ManagedSpaceID": NSNumber(value: id), "type": NSNumber(value: type)]
    }

    private func decode<T: Decodable>(_ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    // MARK: desktop list (step 2)

    func test_six_desktop_spaces_number_one_to_six_in_order() {
        let list = DesktopList.parse([["Display Identifier": "Main", "Spaces": [1, 4, 3, 5, 6, 914].map { space($0) }]], mainDisplayId: nil)
        XCTAssertEqual(list.map(\.number), [1, 2, 3, 4, 5, 6])
        XCTAssertEqual(list.map(\.id), [1, 4, 3, 5, 6, 914])
        XCTAssertTrue(list.allSatisfy(\.isMain))
    }

    func test_a_fullscreen_space_in_the_middle_is_skipped_and_numbering_continues() {
        let list = DesktopList.parse([["Display Identifier": "Main", "Spaces": [space(1), space(9, type: 4), space(3)]]], mainDisplayId: nil)
        XCTAssertEqual(list.map(\.number), [1, 2])
        XCTAssertEqual(list.map(\.id), [1, 3])
    }

    func test_two_displays_number_across_both_and_only_the_main_one_is_main() {
        let list = DesktopList.parse([
            ["Display Identifier": "AAAA", "Spaces": [space(1), space(2)]],
            ["Display Identifier": "BBBB", "Spaces": [space(7)]],
        ], mainDisplayId: "bbbb")
        XCTAssertEqual(list.map(\.number), [1, 2, 3])
        XCTAssertEqual(list.map(\.isMain), [false, false, true])
    }

    func test_unknown_display_ids_make_the_first_display_main() {
        let list = DesktopList.parse([
            ["Display Identifier": "AAAA", "Spaces": [space(1)]], ["Display Identifier": "BBBB", "Spaces": [space(2)]],
        ], mainDisplayId: "CCCC")
        XCTAssertEqual(list.map(\.isMain), [true, false])
    }

    func test_current_space_is_the_main_displays_even_when_the_second_display_has_focus() {
        let displays: [[String: Any]] = [
            ["Display Identifier": "Main", "Current Space": space(4), "Spaces": [space(1), space(4)]],
            ["Display Identifier": "EXT", "Current Space": space(20), "Spaces": [space(20), space(21)]],
        ]
        XCTAssertEqual(DesktopList.currentMainSpace(displays, mainDisplayId: nil), 4)
    }

    func test_current_space_follows_the_main_display_id_when_no_display_is_called_main() {
        let displays: [[String: Any]] = [
            ["Display Identifier": "AAAA", "Current Space": space(20), "Spaces": [space(20)]],
            ["Display Identifier": "BBBB", "Current Space": space(7), "Spaces": [space(7)]],
        ]
        XCTAssertEqual(DesktopList.currentMainSpace(displays, mainDisplayId: "bbbb"), 7)
    }

    func test_no_current_space_without_displays() {
        XCTAssertNil(DesktopList.currentMainSpace([], mainDisplayId: nil))
    }

    func test_no_displays_means_no_desktops() {
        XCTAssertEqual(DesktopList.parse([], mainDisplayId: nil), [])
    }

    func test_window_desktop_is_nil_for_none_several_or_a_non_desktop_space() {
        let list = DesktopList.parse([["Display Identifier": "Main", "Spaces": [space(1), space(4), space(9, type: 4)]]], mainDisplayId: nil)
        XCTAssertEqual(DesktopList.number(ofSpaces: [4], in: list), 2)
        XCTAssertNil(DesktopList.number(ofSpaces: [], in: list))
        XCTAssertNil(DesktopList.number(ofSpaces: [1, 4], in: list))
        XCTAssertNil(DesktopList.number(ofSpaces: [9], in: list))
    }

    func test_second_display_windows_have_no_desktop() {
        let list = DesktopList.parse([
            ["Display Identifier": "Main", "Spaces": [space(1)]], ["Display Identifier": "BBBB", "Spaces": [space(2)]],
        ], mainDisplayId: nil)
        XCTAssertNil(DesktopList.number(ofSpaces: [2], in: list))
    }

    // MARK: desktop keys (step 3)

    func test_control_mask_maps_to_control_flag() {
        XCTAssertEqual(DesktopKeys.flags(fromSymbolicModifiers: 0x40000), .maskControl)
    }

    func test_control_fn_mask_maps_to_control_fn_and_numeric_pad() {
        XCTAssertEqual(DesktopKeys.flags(fromSymbolicModifiers: 0x840000), [.maskControl, .maskSecondaryFn, .maskNumericPad])
    }

    func test_desktop_zero_or_above_sixteen_has_no_hotkey() {
        XCTAssertEqual(DesktopKeys.hotKeyId(forDesktop: 1), 118)
        XCTAssertEqual(DesktopKeys.hotKeyId(forDesktop: 16), 133)
        XCTAssertNil(DesktopKeys.hotKeyId(forDesktop: 0))
        XCTAssertNil(DesktopKeys.hotKeyId(forDesktop: 17))
    }

    func test_restore_list_round_trips_through_the_file() {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("sy-hotkeys-\(UUID().uuidString).json")
        let file = HotKeyRestoreFile(url: url)
        XCTAssertEqual(file.load(), [])
        file.save([118, 120])
        XCTAssertEqual(file.load(), [118, 120])
        file.save([])
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }

    // MARK: all-desktop window list (step 4)

    func test_a_cached_window_missing_from_the_window_server_is_dropped() {
        let kept = DesktopMerge.keep(cached: [5], listed: [], alive: [], desktopOf: [5: 3], active: 1)
        XCTAssertEqual(kept, [])
    }

    func test_a_cached_window_on_another_desktop_is_kept() {
        let kept = DesktopMerge.keep(cached: [5, 6], listed: [], alive: [5, 6], desktopOf: [5: 3, 6: 1], active: 1)
        XCTAssertEqual(kept, [5])
    }

    func test_a_window_in_both_lists_appears_once() {
        XCTAssertEqual(DesktopMerge.keep(cached: [5], listed: [5], alive: [5], desktopOf: [5: 3], active: 1), [])
    }

    func test_without_a_known_active_desktop_nothing_is_kept() {
        XCTAssertEqual(DesktopMerge.keep(cached: [5], listed: [], alive: [5], desktopOf: [5: 3], active: nil), [])
    }

    // MARK: carry plan (step 6)

    private func move(_ key: String, _ from: Int, _ to: Int) -> CarryMove { CarryMove(key: key, from: from, to: to) }

    func test_nothing_to_move_means_no_steps() {
        XCTAssertEqual(CarryPlan.make([], start: 1).steps, [])
        XCTAssertEqual(CarryPlan.make([move("a", 2, 2)], start: 1).steps, [])
    }

    func test_one_window_on_the_current_desktop_is_carried_then_the_plan_returns() {
        XCTAssertEqual(CarryPlan.make([move("a", 1, 3)], start: 1).steps, [.carry("a", to: 3), .goTo(1)])
    }

    func test_a_swap_costs_two_carries_and_one_return_with_no_wasted_go_to() {
        let steps = CarryPlan.make([move("x", 2, 3), move("y", 3, 2)], start: 1).steps
        XCTAssertEqual(steps, [.goTo(2), .carry("x", to: 3), .carry("y", to: 2), .goTo(1)])
    }

    func test_after_a_drop_a_window_waiting_on_that_desktop_goes_next() {
        let steps = CarryPlan.make([move("a", 1, 2), move("b", 4, 1), move("c", 2, 5)], start: 1).steps
        XCTAssertEqual(steps, [.carry("a", to: 2), .carry("c", to: 5), .goTo(4), .carry("b", to: 1)])
    }

    func test_more_than_thirty_moves_keeps_the_first_thirty_and_counts_the_rest() {
        let moves = (0..<34).map { move("w\($0)", 1, 2) }
        let plan = CarryPlan.make(moves, start: 2)
        XCTAssertEqual(plan.steps.filter { if case .carry = $0 { return true } else { return false } }.count, 30)
        XCTAssertEqual(plan.leftOver, 4)
    }

    func test_the_plan_always_ends_on_the_starting_desktop() {
        let plan = CarryPlan.make([move("a", 3, 4), move("b", 5, 6)], start: 2)
        XCTAssertEqual(plan.steps.last, .goTo(2))
    }

    // MARK: carrier (step 5)

    func test_verification_maps_the_windows_spaces_to_moved_or_not() {
        XCTAssertTrue(CarryCheck.moved(spacesAfter: [6], target: 6))
        XCTAssertFalse(CarryCheck.moved(spacesAfter: [3], target: 6))
        XCTAssertFalse(CarryCheck.moved(spacesAfter: [3, 6], target: 6))
    }

    func test_the_retry_runs_at_most_once() throws {
        var calls: [Double] = []
        let result = try CarryRetry.run { scale in calls.append(scale); return false }
        XCTAssertNil(result)
        XCTAssertEqual(calls, [1, 2])
        var second: [Double] = []
        let ok = try CarryRetry.run { scale in second.append(scale); return true }
        XCTAssertEqual(ok, 0)
        XCTAssertEqual(second, [1])
    }

    func test_a_window_without_a_zoom_button_only_gets_edge_grabs() {
        let frame = Rect(x: 100, y: 100, width: 400, height: 300)
        let kinds = CarryGrab.candidates(zoomButton: nil, window: frame, screens: [Rect(x: 0, y: 0, width: 1500, height: 900)], preferred: nil).map(\.kind)
        XCTAssertFalse(kinds.contains(.titleBar))
        XCTAssertEqual(CarryGrab.point(zoomButton: nil, window: frame), .failure(.noTitleBar))
    }

    func test_the_failure_summary_names_moved_and_failed_windows() {
        let text = CarryReport.summary(moved: 7, failed: [("k1", "no grab point"), ("k2", "window did not move")], leftOver: 0)
        XCTAssertEqual(text, "moved 7, could not move 2: k1: no grab point; k2: window did not move")
        XCTAssertEqual(CarryReport.summary(moved: 30, failed: [], leftOver: 3), "moved 30, 3 left to sort (limit reached)")
        XCTAssertNil(CarryReport.summary(moved: 2, failed: [], leftOver: 0))
    }

    // MARK: commands and wire shapes (step 8)

    func test_show_decodes_its_desktop_and_move_windows_its_moves() throws {
        let show: AppCommand = try decode(#"{"seq":1,"type":"show","contextId":"c","windowKeys":[],"hideKeys":[],"desktop":3}"#)
        XCTAssertEqual(show.desktop, 3)
        let moves: AppCommand = try decode(#"{"seq":2,"type":"moveWindows","moves":[{"windowKey":"a","desktop":2}]}"#)
        XCTAssertEqual(moves.moves, [WindowMoveDTO(windowKey: "a", desktop: 2)])
    }

    func test_a_show_without_desktop_decodes_to_nil_and_takes_the_old_path() throws {
        let show: AppCommand = try decode(#"{"seq":1,"type":"show","contextId":"c","windowKeys":[],"hideKeys":[]}"#)
        XCTAssertNil(show.desktop)
        XCTAssertEqual(show.moves, [])
    }

    func test_move_windows_runs_in_the_window_lane() {
        XCTAssertEqual(CommandLane.of("moveWindows"), .windows)
    }

    func test_snapshot_sends_desktops_can_carry_and_each_windows_desktop() throws {
        let w = WindowSnapshot(key: "k", app: "A", bundleId: "b", pid: 1, title: "t", document: nil, browser: nil, desktop: nil)
        let body = SnapshotBody(windows: [w], desktops: DesktopsInfo(count: 6, active: 2), canCarry: true)
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any]
        XCTAssertEqual((json?["desktops"] as? [String: Int])?["count"], 6)
        XCTAssertEqual(json?["canCarry"] as? Bool, true)
        let first = (json?["windows"] as? [[String: Any]])?.first
        XCTAssertTrue(first?["desktop"] is NSNull)
    }

    func test_contexts_decode_their_desktop_and_the_to_sort_count() throws {
        let r: ContextsResponse = try decode(#"{"contexts":[{"id":"a","name":"A","status":"idle","desktop":6,"desktopShared":true}],"toSort":3,"desktopMode":"desktops"}"#)
        XCTAssertEqual(r.contexts.first?.desktop, 6)
        XCTAssertEqual(r.contexts.first?.desktopShared, true)
        XCTAssertEqual(r.toSort, 3)
        XCTAssertTrue(r.desktopMode)
    }

    // MARK: local switch with desktops

    private func ctx(_ id: String, desktop: Int?, windows: [String]) -> ContextDTO {
        ContextDTO(id: id, name: id, key: nil, color: nil, status: "idle", windows: windows.map { WindowRef(key: $0) }, desktop: desktop)
    }

    func test_local_switch_to_an_own_desktop_hides_nothing_and_names_the_desktop() {
        let plan = LocalSwitch.plan(contexts: [ctx("a", desktop: 1, windows: ["a1"]), ctx("b", desktop: 2, windows: ["b1"])], target: "b")
        XCTAssertEqual(plan?.desktop, 2)
        XCTAssertEqual(plan?.sets.hide ?? ["x"], [])
    }

    func test_local_switch_on_the_shared_desktop_hides_the_other_shared_contexts() {
        let plan = LocalSwitch.plan(contexts: [ctx("a", desktop: 1, windows: ["a1"]), ctx("f", desktop: 6, windows: ["f1"]),
                                               ctx("g", desktop: 6, windows: ["g1"])], target: "f")
        XCTAssertEqual(plan?.sets.hide ?? [], ["g1"])
    }

    // MARK: menu (step 9)

    func test_menu_row_names_the_desktop() {
        XCTAssertEqual(MenuPanelLogic.detail(ctx("a", desktop: 2, windows: ["x"])), "idle · 1 window · Desktop 2")
        let shared = ContextDTO(id: "f", name: "f", key: 7, color: nil, status: "idle", windows: [], desktop: 6, desktopShared: true)
        XCTAssertEqual(MenuPanelLogic.detail(shared), "idle · 0 windows · Desktop 6 (shared)")
        XCTAssertEqual(MenuPanelLogic.detail(ctx("a", desktop: nil, windows: [])), "idle · 0 windows")
    }

    func test_menu_to_sort_text_hides_at_zero() {
        XCTAssertNil(MenuPanelLogic.toSortText(0))
        XCTAssertEqual(MenuPanelLogic.toSortText(1), "1 window to sort")
        XCTAssertEqual(MenuPanelLogic.toSortText(4), "4 windows to sort")
    }
}
