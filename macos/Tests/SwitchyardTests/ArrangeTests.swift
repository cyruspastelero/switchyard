import Foundation
import XCTest
@testable import Switchyard

/// No bounce, the arrival HUD, the menu bar title and the v2 wire fields.
final class ArrangeTests: XCTestCase {
    private func decode<T: Decodable>(_ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    private func ctx(_ id: String, name: String? = nil, desktop: Int?, windows: [(String, Int?)]) -> ContextDTO {
        ContextDTO(id: id, name: name ?? id, key: nil, color: nil, status: "idle",
                   windows: windows.map { WindowRef(key: $0.0, desktop: $0.1) }, desktop: desktop)
    }

    // MARK: show raises only what is on the target desktop

    func test_local_switch_skips_a_window_that_sits_on_another_desktop() {
        let contexts = [ctx("a", desktop: 2, windows: [("k1", 2), ("k2", 2), ("k3", 1)]), ctx("b", desktop: 2, windows: [("b1", 2)])]
        let plan = LocalSwitch.plan(contexts: contexts, target: "a")
        XCTAssertEqual(plan?.order.count, 2)
        XCTAssertEqual(plan?.strays ?? [], ["k3"])
        XCTAssertFalse(plan?.sets.shown.contains("k3") ?? true)
        XCTAssertFalse(plan?.sets.hide.contains("k3") ?? true)
    }

    func test_local_switch_in_off_screen_mode_raises_every_window() {
        let contexts = [ctx("a", desktop: nil, windows: [("k1", 2), ("k2", 2), ("k3", 1)])]
        let plan = LocalSwitch.plan(contexts: contexts, target: "a")
        XCTAssertEqual(plan?.order ?? [], ["k1", "k2", "k3"])
        XCTAssertEqual(plan?.strays ?? ["x"], [])
    }

    func test_raise_filter_keeps_only_windows_on_the_active_desktop() {
        let targets: [(key: String, desktop: Int?)] = [("a", 2), ("b", 1), ("c", nil), ("d", 2)]
        XCTAssertEqual(RaiseFilter.onDesktop(targets, active: 2), ["a", "d"])
    }

    func test_raise_filter_without_an_active_desktop_keeps_everything() {
        let targets: [(key: String, desktop: Int?)] = [("a", 2), ("b", 1), ("c", nil)]
        XCTAssertEqual(RaiseFilter.onDesktop(targets, active: nil), ["a", "b", "c"])
    }

    func test_an_app_whose_only_window_was_filtered_out_is_never_activated() {
        let all = [RaiseTarget(key: "c1", pid: 10), RaiseTarget(key: "c2", pid: 20)]
        let kept = Set(RaiseFilter.onDesktop([("c1", 2), ("c2", 1)], active: 2))
        let steps = RaisePlan.steps(all.filter { kept.contains($0.key) })
        XCTAssertFalse(steps.contains(.activate(20)))
        XCTAssertTrue(steps.contains(.activate(10)))
    }

    func test_bounce_check_goes_back_once_then_gives_up() {
        XCTAssertEqual(ShowBounce.decide(target: 2, landed: 2, alreadyCorrected: false), .ok)
        XCTAssertEqual(ShowBounce.decide(target: 2, landed: 1, alreadyCorrected: false), .goBack)
        XCTAssertEqual(ShowBounce.decide(target: 2, landed: 1, alreadyCorrected: true), .giveUp)
        XCTAssertEqual(ShowBounce.decide(target: 2, landed: nil, alreadyCorrected: false), .ok)
    }

    // MARK: HUD

    func test_hud_names_the_context_and_its_desktop() {
        XCTAssertEqual(HUDText.make(contextName: "aral", desktop: 2, shared: false, strays: [], unsortedHere: 0, sharedDesktop: 6),
                       HUDText(title: "aral · Desktop 2", hint: nil))
    }

    func test_hud_on_the_shared_desktop_and_on_a_desktop_without_a_context() {
        XCTAssertEqual(HUDText.make(contextName: "aral", desktop: 6, shared: true, strays: [], unsortedHere: 0, sharedDesktop: 6).title,
                       "Shared · Desktop 6")
        XCTAssertEqual(HUDText.make(contextName: nil, desktop: 4, shared: false, strays: [], unsortedHere: 0, sharedDesktop: 6).title,
                       "Desktop 4")
    }

    func test_hud_hint_names_where_stray_windows_are() {
        XCTAssertEqual(HUDText.make(contextName: "aral", desktop: 2, shared: false, strays: [1], unsortedHere: 0, sharedDesktop: 6).hint,
                       "1 window still on Desktop 1 · Sort")
        XCTAssertEqual(HUDText.make(contextName: "aral", desktop: 2, shared: false, strays: [1, 1], unsortedHere: 0, sharedDesktop: 6).hint,
                       "2 windows still on Desktop 1 · Sort")
        XCTAssertEqual(HUDText.make(contextName: "aral", desktop: 2, shared: false, strays: [1, 3], unsortedHere: 0, sharedDesktop: 6).hint,
                       "2 windows still on other desktops · Sort")
    }

    func test_hud_hint_counts_unsorted_windows_here() {
        XCTAssertEqual(HUDText.make(contextName: "aral", desktop: 2, shared: false, strays: [], unsortedHere: 2, sharedDesktop: 6).hint,
                       "2 windows here are unsorted · Sort moves them to Desktop 6")
        XCTAssertEqual(HUDText.make(contextName: "aral", desktop: 2, shared: false, strays: [], unsortedHere: 1, sharedDesktop: 6).hint,
                       "1 window here is unsorted · Sort moves it to Desktop 6")
    }

    func test_a_long_context_name_is_cut_with_an_ellipsis() {
        let name = String(repeating: "x", count: 40)
        let title = HUDText.make(contextName: name, desktop: 2, shared: false, strays: [], unsortedHere: 0, sharedDesktop: 6).title
        XCTAssertTrue(title.hasPrefix(String(repeating: "x", count: 27) + "…"))
        XCTAssertTrue(title.hasSuffix(" · Desktop 2"))
    }

    func test_strays_of_a_context_are_its_windows_known_to_be_elsewhere() {
        let c = ctx("a", desktop: 2, windows: [("k1", 2), ("k2", 1), ("k3", nil)])
        XCTAssertEqual(ContextStrays.desktops(c), [1])
    }

    // MARK: menu bar title

    func test_menu_bar_title_is_the_active_context_name() {
        let contexts = [ctx("a", name: "aral", desktop: 2, windows: []), ctx("b", name: "tala", desktop: 3, windows: [])]
        XCTAssertEqual(MenuLabel.title(contexts: contexts, activeContextId: "b"), "tala")
        XCTAssertNil(MenuLabel.title(contexts: contexts, activeContextId: nil))
        XCTAssertNil(MenuLabel.title(contexts: contexts, activeContextId: "gone"))
    }

    func test_menu_bar_title_is_short() {
        let contexts = [ctx("a", name: String(repeating: "y", count: 30), desktop: 2, windows: [])]
        XCTAssertEqual(MenuLabel.title(contexts: contexts, activeContextId: "a"), String(repeating: "y", count: 17) + "…")
    }

    // MARK: wire fields

    func test_a_window_ref_reads_its_desktop_and_a_missing_one_is_nil() throws {
        let r: ContextsResponse = try decode("""
            {"contexts":[{"id":"a","name":"a","strays":1,"windows":[{"key":"k1","desktop":1},{"key":"k2"}]}],
             "unsorted":[{"key":"u1","desktop":2}],"unsortedToMove":1,"autoTidy":false}
            """)
        XCTAssertEqual(r.contexts[0].windows, [WindowRef(key: "k1", desktop: 1), WindowRef(key: "k2", desktop: nil)])
        XCTAssertEqual(r.contexts[0].strays, 1)
        XCTAssertEqual(r.unsorted, [WindowRef(key: "u1", desktop: 2)])
        XCTAssertEqual(r.unsortedCount, 1)
        XCTAssertEqual(r.unsortedToMove, 1)
        XCTAssertFalse(r.autoTidy)
    }

    func test_old_server_views_decode_with_defaults() throws {
        let r: ContextsResponse = try decode(#"{"contexts":[{"id":"a","name":"a","windows":[{"key":"k1"}]}]}"#)
        XCTAssertEqual(r.contexts[0].strays, 0)
        XCTAssertEqual(r.unsortedToMove, 0)
        XCTAssertTrue(r.autoTidy)
    }

    func test_show_command_reads_its_stray_keys() throws {
        let c: AppCommand = try decode(#"{"seq":1,"type":"show","windowKeys":["a"],"hideKeys":[],"strayKeys":["s"],"desktop":2}"#)
        XCTAssertEqual(c.strayKeys, ["s"])
    }

    func test_move_command_reads_the_desktops_to_tidy_and_defaults_to_none() throws {
        let with: AppCommand = try decode(#"{"seq":1,"type":"moveWindows","moves":[{"windowKey":"k","desktop":2}],"tidy":[1,2]}"#)
        XCTAssertEqual(with.tidy, [1, 2])
        let without: AppCommand = try decode(#"{"seq":2,"type":"moveWindows","moves":[]}"#)
        XCTAssertEqual(without.tidy, [])
    }

    func test_tidy_command_reads_desktops_and_force() throws {
        let c: AppCommand = try decode(#"{"seq":3,"type":"tidy","payload":{"desktops":[{"desktop":2,"windowKeys":["a","b"]}],"force":true}}"#)
        XCTAssertEqual(c.tidyDesktops, [TidyDesktopDTO(desktop: 2, windowKeys: ["a", "b"])])
        XCTAssertTrue(c.force)
        let plain: AppCommand = try decode(#"{"seq":4,"type":"tidy","desktops":[]}"#)
        XCTAssertFalse(plain.force)
    }

    func test_tidy_runs_in_the_window_lane() {
        XCTAssertEqual(CommandLane.of("tidy"), .windows)
        XCTAssertEqual(CommandLane.of("undoTidy"), .windows)
        XCTAssertEqual(CommandLane.of("captureLayout"), .windows)
    }

    func test_undo_tidy_command_reads_its_desktop() throws {
        let c: AppCommand = try decode(#"{"seq":5,"type":"undoTidy","payload":{"desktop":3}}"#)
        XCTAssertEqual(c.desktop, 3)
    }
}
