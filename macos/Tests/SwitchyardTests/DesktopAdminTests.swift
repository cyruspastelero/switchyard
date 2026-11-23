import CoreGraphics
import Foundation
import XCTest
@testable import Switchyard

final class DesktopAdminTests: XCTestCase {
    private func space(_ id: UInt64, type: Int = 0) -> [String: Any] {
        ["ManagedSpaceID": NSNumber(value: id), "type": NSNumber(value: type)]
    }

    private func display(_ id: String, _ spaces: [[String: Any]]) -> [String: Any] {
        ["Display Identifier": id, "Spaces": spaces]
    }

    /// Laptop with 1, 2 and a fullscreen space, then a monitor with 7 and 8.
    private var twoScreens: [[String: Any]] {
        [display("LAPTOP", [space(1), space(2), space(90, type: 4)]), display("EXT", [space(7), space(8)])]
    }

    // MARK: snapshot list

    func test_entries_number_desktops_across_screens_and_mark_the_laptop_and_what_shows() {
        let desktops = DesktopList.parse(twoScreens, mainDisplayId: nil)
        let list = DesktopAdmin.entries(desktops, showing: [2, 7], builtin: { $0 == "LAPTOP" })
        XCTAssertEqual(list.map(\.number), [1, 2, 3, 4])
        XCTAssertEqual(list.map(\.space), [1, 2, 7, 8])
        XCTAssertEqual(list.map(\.screen), [1, 1, 2, 2])
        XCTAssertEqual(list.map(\.builtin), [true, true, false, false])
        XCTAssertEqual(list.map(\.showing), [false, true, true, false])
    }

    func test_entries_stop_at_sixteen_desktops() {
        let desktops = DesktopList.parse([display("Main", (1...18).map { space(UInt64($0)) })], mainDisplayId: nil)
        XCTAssertEqual(DesktopAdmin.entries(desktops, showing: [], builtin: { _ in true }).count, 16)
    }

    func test_a_screen_with_only_fullscreen_spaces_does_not_take_a_screen_number() {
        let displays = [display("A", [space(1)]), display("B", [space(5, type: 4)]), display("C", [space(9)])]
        let list = DesktopAdmin.entries(DesktopList.parse(displays, mainDisplayId: nil), showing: [], builtin: { _ in false })
        XCTAssertEqual(list.map(\.screen), [1, 2])
    }

    func test_desktops_info_sends_its_list_only_when_there_is_one() throws {
        let entry = DesktopEntryDTO(number: 1, space: 42, screen: 1, builtin: true, showing: true)
        let with = try JSONSerialization.jsonObject(with: JSONEncoder().encode(DesktopsInfo(count: 1, active: 1, list: [entry]))) as? [String: Any]
        let first = (with?["list"] as? [[String: Any]])?.first
        XCTAssertEqual(first?["space"] as? Int, 42)
        XCTAssertEqual(first?["builtin"] as? Bool, true)
        let without = try JSONSerialization.jsonObject(with: JSONEncoder().encode(DesktopsInfo(count: 1, active: 1))) as? [String: Any]
        XCTAssertNil(without?["list"])
    }

    // MARK: commands

    func test_desktop_commands_decode_their_fields_and_run_in_the_window_lane() throws {
        let close = try JSONDecoder().decode(AppCommand.self, from: Data(#"{"seq":1,"type":"closeDesktop","number":3,"spaceCheck":77}"#.utf8))
        XCTAssertEqual(close.number, 3)
        XCTAssertEqual(close.spaceCheck, 77)
        let add = try JSONDecoder().decode(AppCommand.self, from: Data(#"{"seq":2,"type":"addDesktop","screen":2}"#.utf8))
        XCTAssertEqual(add.screen, 2)
        for type in ["showDesktop", "addDesktop", "closeDesktop"] { XCTAssertEqual(CommandLane.of(type), .windows) }
    }

    // MARK: close target

    func test_close_target_counts_fullscreen_spaces_in_the_button_index() {
        let displays = [display("A", [space(1), space(90, type: 4), space(2)])]
        XCTAssertEqual(DesktopAdmin.closeTarget(displays, number: 2, space: 2),
                       .success(SpaceButton(displayIndex: 0, displayId: "A", buttonIndex: 2, buttonCount: 3)))
    }

    func test_close_target_on_the_second_screen_indexes_within_that_screen() {
        XCTAssertEqual(DesktopAdmin.closeTarget(twoScreens, number: 4, space: 8),
                       .success(SpaceButton(displayIndex: 1, displayId: "EXT", buttonIndex: 1, buttonCount: 2)))
    }

    func test_close_aborts_when_the_number_now_maps_to_another_space() {
        XCTAssertEqual(DesktopAdmin.closeTarget(twoScreens, number: 2, space: 7), .failure(.changed(2)))
    }

    func test_close_refuses_a_missing_desktop_and_the_last_one_on_a_screen() {
        XCTAssertEqual(DesktopAdmin.closeTarget(twoScreens, number: 9, space: 1), .failure(.noSuchDesktop(9)))
        let lone = [display("A", [space(1), space(90, type: 4)]), display("B", [space(3)])]
        XCTAssertEqual(DesktopAdmin.closeTarget(lone, number: 1, space: 1), .failure(.lastOnScreen(1)))
    }

    func test_add_target_names_the_screens_display() {
        XCTAssertEqual(DesktopAdmin.addTarget(twoScreens, screen: 2),
                       .success(SpaceButton(displayIndex: 1, displayId: "EXT", buttonIndex: 2, buttonCount: 2)))
        XCTAssertEqual(DesktopAdmin.addTarget(twoScreens, screen: 3), .failure(.noSuchScreen(3)))
    }

    // MARK: before and after

    func test_stepping_aside_picks_the_previous_desktop_on_the_same_screen_else_the_next() {
        let desktops = DesktopList.parse(twoScreens, mainDisplayId: nil)
        XCTAssertEqual(DesktopAdmin.stepAside(from: 2, in: desktops), 1)
        XCTAssertEqual(DesktopAdmin.stepAside(from: 3, in: desktops), 4)
        XCTAssertNil(DesktopAdmin.stepAside(from: 1, in: DesktopList.parse([display("A", [space(1)])], mainDisplayId: nil)))
    }

    func test_verification_reads_the_space_gone_or_one_more_desktop() {
        XCTAssertFalse(DesktopAdmin.isGone(twoScreens, space: 8))
        XCTAssertTrue(DesktopAdmin.isGone(twoScreens, space: 3))
        XCTAssertEqual(DesktopAdmin.desktopCount(twoScreens, displayId: "LAPTOP"), 2)
        XCTAssertEqual(DesktopAdmin.desktopCount(twoScreens, displayId: "NOPE"), 0)
    }

    func test_mission_control_display_is_the_one_covering_the_screen_most() {
        let laptop = Rect(x: 0, y: 0, width: 1512, height: 982)
        let monitor = Rect(x: 1512, y: -200, width: 2560, height: 1440)
        XCTAssertEqual(DesktopAdmin.matchDisplay(frames: [monitor, laptop], screen: laptop), 1)
        XCTAssertEqual(DesktopAdmin.matchDisplay(frames: [nil, monitor], screen: monitor), 1)
        XCTAssertNil(DesktopAdmin.matchDisplay(frames: [monitor], screen: laptop))
    }
}
