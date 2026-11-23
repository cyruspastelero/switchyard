import Foundation
import XCTest
@testable import Switchyard

final class PresetLayoutTests: XCTestCase {
    // Laptop below-left of a wider external monitor; Accessibility coordinates (top-left origin).
    private let laptop = PresetScreen(uuid: "LAP", builtin: true, frame: Rect(x: 0, y: 0, width: 1000, height: 800),
                                      area: Rect(x: 0, y: 25, width: 1000, height: 775), isMain: true)
    private let external = PresetScreen(uuid: "EXT", builtin: false, frame: Rect(x: 1000, y: 0, width: 2000, height: 1000),
                                        area: Rect(x: 1000, y: 0, width: 2000, height: 1000), isMain: false)

    private func slot(_ bundleId: String, _ uuid: String, builtin: Bool, _ f: SlotFrame) -> LayoutSlotDTO {
        LayoutSlotDTO(bundleId: bundleId, app: bundleId, screen: SlotScreen(uuid: uuid, builtin: builtin), frame: f)
    }

    func test_capture_stores_fractions_of_each_screens_visible_area_front_to_back() {
        let windows = [
            CaptureWindow(bundleId: "chrome", app: "Chrome", frame: Rect(x: 1000, y: 0, width: 1000, height: 1000), z: 5),
            CaptureWindow(bundleId: "ghostty", app: "Ghostty", frame: Rect(x: 0, y: 25, width: 500, height: 775), z: 1),
        ]
        let slots = PresetLayout.capture(windows, screens: [laptop, external])
        XCTAssertEqual(slots.map(\.bundleId), ["ghostty", "chrome"])
        XCTAssertEqual(slots[0].screen, SlotScreen(uuid: "LAP", builtin: true))
        XCTAssertEqual(slots[0].frame, SlotFrame(x: 0, y: 0, w: 0.5, h: 1))
        XCTAssertEqual(slots[1].screen, SlotScreen(uuid: "EXT", builtin: false))
        XCTAssertEqual(slots[1].frame, SlotFrame(x: 0, y: 0, w: 0.5, h: 1))
    }

    func test_capture_clamps_a_window_hanging_off_its_screen_and_skips_empty_ones() {
        let windows = [
            CaptureWindow(bundleId: "a", app: "A", frame: Rect(x: -100, y: 25, width: 1200, height: 900), z: 0),
            CaptureWindow(bundleId: "b", app: "B", frame: Rect(x: 10, y: 30, width: 0, height: 100), z: 1),
        ]
        let slots = PresetLayout.capture(windows, screens: [laptop])
        XCTAssertEqual(slots.count, 1)
        XCTAssertEqual(slots[0].frame.x, 0)
        XCTAssertEqual(slots[0].frame.w, 1)
        XCTAssertEqual(slots[0].frame.h, 1)
    }

    func test_capture_keeps_at_most_fifty_slots() {
        let windows = (0..<60).map { CaptureWindow(bundleId: "a", app: "A", frame: Rect(x: 0, y: 25, width: 100, height: 100), z: $0) }
        XCTAssertEqual(PresetLayout.capture(windows, screens: [laptop]).count, 50)
    }

    func test_the_nth_window_of_an_app_takes_its_nth_slot() {
        let slots = [slot("g", "LAP", builtin: true, SlotFrame(x: 0, y: 0, w: 0.5, h: 1)),
                     slot("g", "LAP", builtin: true, SlotFrame(x: 0.5, y: 0, w: 0.5, h: 1))]
        let windows = [PresetWindow(key: "back", bundleId: "g", z: 9, number: 1), PresetWindow(key: "front", bundleId: "g", z: 2, number: 2)]
        let frames = PresetLayout.assign(windows, slots: slots, screens: [laptop])
        XCTAssertEqual(frames["front"], Rect(x: 0, y: 25, width: 500, height: 775))
        XCTAssertEqual(frames["back"], Rect(x: 500, y: 25, width: 500, height: 775))
    }

    func test_extra_windows_of_an_app_deck_on_its_last_slot() {
        let slots = [slot("g", "LAP", builtin: true, SlotFrame(x: 0, y: 0, w: 0.5, h: 0.5))]
        let windows = (0..<3).map { PresetWindow(key: "w\($0)", bundleId: "g", z: $0, number: UInt32($0)) }
        let frames = PresetLayout.assign(windows, slots: slots, screens: [laptop])
        XCTAssertEqual(frames["w0"]?.x, 0)
        XCTAssertEqual(frames["w1"]?.x, 30)
        XCTAssertEqual(frames["w2"]?.y, 25 + 60)
    }

    func test_a_missing_screen_falls_back_to_one_with_the_same_builtin_flag_then_the_main_one() {
        let other = PresetScreen(uuid: "NEW", builtin: false, frame: Rect(x: 1000, y: 0, width: 1000, height: 500),
                                 area: Rect(x: 1000, y: 0, width: 1000, height: 500), isMain: false)
        let slots = [slot("c", "GONE", builtin: false, SlotFrame(x: 0, y: 0, w: 1, h: 1)),
                     slot("g", "GONE2", builtin: true, SlotFrame(x: 0, y: 0, w: 1, h: 1))]
        let windows = [PresetWindow(key: "c", bundleId: "c", z: 0, number: 1), PresetWindow(key: "g", bundleId: "g", z: 1, number: 2)]
        let frames = PresetLayout.assign(windows, slots: slots, screens: [laptop, other])
        XCTAssertEqual(frames["c"], other.area)
        XCTAssertEqual(frames["g"], laptop.area)
        XCTAssertEqual(PresetLayout.assign(windows, slots: slots, screens: [laptop])["c"], laptop.area)
    }

    func test_fractions_scale_to_a_screen_of_another_size() {
        let slots = [slot("c", "EXT", builtin: false, SlotFrame(x: 0.5, y: 0.5, w: 0.5, h: 0.5))]
        let frames = PresetLayout.assign([PresetWindow(key: "c", bundleId: "c", z: 0, number: 1)], slots: slots, screens: [external])
        XCTAssertEqual(frames["c"], Rect(x: 2000, y: 500, width: 1000, height: 500))
    }

    func test_with_separate_spaces_slots_for_the_other_screen_are_ignored() {
        let slots = [slot("c", "EXT", builtin: false, SlotFrame(x: 0, y: 0, w: 1, h: 1)),
                     slot("g", "LAP", builtin: true, SlotFrame(x: 0, y: 0, w: 1, h: 1))]
        let windows = [PresetWindow(key: "c", bundleId: "c", z: 0, number: 1), PresetWindow(key: "g", bundleId: "g", z: 1, number: 2)]
        let frames = PresetLayout.assign(windows, slots: slots, screens: [laptop, external], onlyScreen: "LAP")
        XCTAssertNil(frames["c"])
        XCTAssertEqual(frames["g"], laptop.area)
    }

    func test_apps_without_a_slot_are_left_for_the_auto_layout() {
        let slots = [slot("g", "LAP", builtin: true, SlotFrame(x: 0, y: 0, w: 1, h: 1))]
        let windows = [PresetWindow(key: "g", bundleId: "g", z: 0, number: 1), PresetWindow(key: "x", bundleId: "x", z: 1, number: 2)]
        XCTAssertEqual(PresetLayout.unslotted(windows, slots: slots), ["x"])
    }

    func test_a_tidy_command_carries_its_slots() throws {
        let json = #"{"seq":1,"type":"tidy","force":true,"desktops":[{"desktop":2,"windowKeys":["a"],"slots":[{"bundleId":"g","app":"Ghostty","screen":{"uuid":"LAP","builtin":true},"frame":{"x":0,"y":0,"w":0.5,"h":1}}]}]}"#
        let cmd = try JSONDecoder().decode(AppCommand.self, from: Data(json.utf8))
        XCTAssertEqual(cmd.tidyDesktops.first?.slots?.first?.frame, SlotFrame(x: 0, y: 0, w: 0.5, h: 1))
        let plain = try JSONDecoder().decode(AppCommand.self, from: Data(#"{"seq":2,"type":"tidy","desktops":[{"desktop":2,"windowKeys":[]}]}"#.utf8))
        XCTAssertNil(plain.tidyDesktops.first?.slots)
    }

    func test_the_owner_contexts_layout_gives_the_desktops_slots() throws {
        let json = #"{"contexts":[{"id":"a","name":"A","status":"idle","desktop":2,"layout":{"id":"p","name":"Desk","slots":[{"bundleId":"g","app":"G","screen":{"uuid":"LAP","builtin":true},"frame":{"x":0,"y":0,"w":1,"h":1}}]}},{"id":"b","name":"B","status":"idle","desktop":3}],"layouts":[{"id":"p","name":"Desk"}]}"#
        let r = try JSONDecoder().decode(ContextsResponse.self, from: Data(json.utf8))
        XCTAssertEqual(r.layoutCount, 1)
        XCTAssertEqual(TidyTargets.slots(contexts: r.contexts, desktop: 2, activeContextId: nil)?.count, 1)
        XCTAssertNil(TidyTargets.slots(contexts: r.contexts, desktop: 3, activeContextId: nil))
    }
}
