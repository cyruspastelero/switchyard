import Foundation
import XCTest
@testable import Switchyard

final class SwitchSpeedTests: XCTestCase {
    private func decode<T: Decodable>(_ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    private func context(_ id: String, status: String = "idle", windows: [String]) -> ContextDTO {
        ContextDTO(id: id, name: id, key: nil, color: nil, status: status, windows: windows.map { WindowRef(key: $0) })
    }

    // MARK: local switch (no server round trip)

    func test_local_switch_shows_the_target_windows_and_hides_every_other_contexts_windows() {
        let contexts = [context("a", windows: ["a1", "a2"]), context("b", windows: ["b1"]), context("c", windows: ["c1"])]
        let plan = LocalSwitch.plan(contexts: contexts, target: "a")
        XCTAssertEqual(plan?.order ?? [], ["a1", "a2"])
        XCTAssertEqual(plan?.sets.shown ?? [], ["a1", "a2"])
        XCTAssertEqual(plan?.sets.hide ?? [], ["b1", "c1"])
    }

    func test_local_switch_is_refused_for_an_unknown_or_parked_context() {
        let contexts = [context("a", windows: ["a1"]), context("p", status: "parked", windows: [])]
        XCTAssertNil(LocalSwitch.plan(contexts: contexts, target: "missing"))
        XCTAssertNil(LocalSwitch.plan(contexts: contexts, target: "p"))
    }

    // MARK: order of work inside a show

    func test_show_brings_target_windows_back_before_anything_is_hidden() {
        let sets = ShowSets(shown: ["t1", "t2"], hide: ["o1", "o2"])
        let phases = ShowPlan.phases(keys: ["o1", "t1", "u1", "o2", "t2"], hidden: ["t1", "o2", "u1"], sets: sets)
        XCTAssertEqual(phases.restoreFirst, ["t1"])   // t2 is already on screen
        XCTAssertEqual(phases.hide, ["o1"])           // o2 is already hidden
        XCTAssertEqual(phases.restoreLast, ["u1"])    // no longer in any hide list: comes back, after the target is in front
    }

    func test_show_with_nothing_to_change_plans_no_window_moves() {
        let sets = ShowSets(shown: ["t1"], hide: ["o1"])
        let phases = ShowPlan.phases(keys: ["t1", "o1", "u1"], hidden: ["o1"], sets: sets)
        XCTAssertTrue(phases.restoreFirst.isEmpty)
        XCTAssertTrue(phases.hide.isEmpty)
        XCTAssertTrue(phases.restoreLast.isEmpty)
    }

    func test_restoring_a_window_only_resizes_it_when_its_frame_had_to_change() {
        let saved = Rect(x: 10, y: 20, width: 800, height: 600)
        XCTAssertFalse(FrameMath.needsResize(saved: saved, target: saved))
        XCTAssertFalse(FrameMath.needsResize(saved: saved, target: Rect(x: 40, y: 60, width: 800, height: 600)))
        XCTAssertTrue(FrameMath.needsResize(saved: saved, target: Rect(x: 40, y: 60, width: 700, height: 600)))
    }

    // MARK: raising

    func test_each_app_is_activated_once_per_run_of_its_windows_and_the_front_window_is_raised_last() {
        // Front-to-back order as the server sends it: two Ghostty windows, then Chrome.
        let steps = RaisePlan.steps([RaiseTarget(key: "g1", pid: 7), RaiseTarget(key: "g2", pid: 7), RaiseTarget(key: "c1", pid: 9)])
        XCTAssertEqual(steps, [.raise("c1"), .activate(9), .raise("g2"), .activate(7), .raise("g1")])
    }

    func test_raising_nothing_takes_no_steps() {
        XCTAssertTrue(RaisePlan.steps([]).isEmpty)
    }

    // MARK: the server's echo of a local switch

    func test_server_echo_of_a_local_switch_does_not_raise_the_same_windows_again() {
        let now = Date()
        var echo = ShowEcho()
        echo.recordLocal(contextId: "a", raised: ["a1", "a2"], at: now)
        let d = echo.decide(contextId: "a", focus: true, windowKeys: ["a1", "a2"], now: now.addingTimeInterval(0.05))
        XCTAssertEqual(d, .apply(raise: []))
    }

    func test_server_echo_raises_only_the_windows_the_local_switch_did_not_know() {
        let now = Date()
        var echo = ShowEcho()
        echo.recordLocal(contextId: "a", raised: ["a1"], at: now)
        let d = echo.decide(contextId: "a", focus: true, windowKeys: ["a1", "new"], now: now.addingTimeInterval(0.05))
        XCTAssertEqual(d, .apply(raise: ["new"]))
    }

    func test_echo_of_an_older_switch_is_skipped_when_a_newer_local_switch_happened() {
        let now = Date()
        var echo = ShowEcho()
        echo.recordLocal(contextId: "a", raised: ["a1"], at: now)
        echo.recordLocal(contextId: "b", raised: ["b1"], at: now.addingTimeInterval(0.1))
        XCTAssertEqual(echo.decide(contextId: "a", focus: true, windowKeys: ["a1"], now: now.addingTimeInterval(0.2)), .skip)
        XCTAssertEqual(echo.decide(contextId: "b", focus: true, windowKeys: ["b1"], now: now.addingTimeInterval(0.2)), .apply(raise: []))
    }

    func test_a_show_that_is_not_an_echo_raises_everything_it_lists() {
        let now = Date()
        var echo = ShowEcho()
        XCTAssertEqual(echo.decide(contextId: "a", focus: true, windowKeys: ["a1", "a2"], now: now), .apply(raise: ["a1", "a2"]))
        // A local switch from long ago is not an echo either.
        echo.recordLocal(contextId: "a", raised: ["a1", "a2"], at: now)
        XCTAssertEqual(echo.decide(contextId: "a", focus: true, windowKeys: ["a1", "a2"], now: now.addingTimeInterval(30)),
                       .apply(raise: ["a1", "a2"]))
    }

    func test_a_show_without_focus_never_raises() {
        var echo = ShowEcho()
        XCTAssertEqual(echo.decide(contextId: "a", focus: false, windowKeys: ["a1"], now: Date()), .apply(raise: []))
    }

    // MARK: apps that do not answer Accessibility

    func test_an_app_that_is_slow_to_list_windows_is_skipped_for_a_while_then_asked_again() {
        let now = Date()
        var slow = SlowApps()
        XCTAssertFalse(slow.shouldSkip(5, now: now))
        XCTAssertEqual(slow.record(pid: 5, seconds: 0.4, now: now), 30)
        XCTAssertTrue(slow.shouldSkip(5, now: now.addingTimeInterval(29)))
        XCTAssertFalse(slow.shouldSkip(5, now: now.addingTimeInterval(31)))
        XCTAssertFalse(slow.shouldSkip(6, now: now))
    }

    func test_the_wait_doubles_while_an_app_stays_slow_and_resets_when_it_answers_fast() {
        let now = Date()
        var slow = SlowApps()
        XCTAssertEqual(slow.record(pid: 5, seconds: 0.4, now: now), 30)
        XCTAssertEqual(slow.record(pid: 5, seconds: 0.4, now: now), 60)
        for _ in 0..<10 { _ = slow.record(pid: 5, seconds: 0.4, now: now) }
        XCTAssertEqual(slow.record(pid: 5, seconds: 0.4, now: now), 300)
        XCTAssertNil(slow.record(pid: 5, seconds: 0.01, now: now))
        XCTAssertFalse(slow.shouldSkip(5, now: now))
        XCTAssertEqual(slow.record(pid: 5, seconds: 0.4, now: now), 30)
    }

    func test_slow_app_records_are_dropped_when_the_app_quits() {
        let now = Date()
        var slow = SlowApps()
        _ = slow.record(pid: 5, seconds: 0.4, now: now)
        slow.keep(only: [6])
        XCTAssertFalse(slow.shouldSkip(5, now: now))
    }

    // MARK: command lanes

    func test_browser_scripts_never_run_in_front_of_a_show() {
        XCTAssertEqual(CommandLane.of("show"), .windows)
        XCTAssertEqual(CommandLane.of("showAll"), .windows)
        for type in ["nameWindow", "openWindow", "closeWindow", "openTab", "closeTab", "somethingNew"] {
            XCTAssertEqual(CommandLane.of(type), .slow)
        }
    }

    // MARK: timing

    func test_command_carries_its_creation_time_so_queue_delay_can_be_logged() throws {
        let c: AppCommand = try decode(#"{"seq":3,"type":"showAll","createdAt":"2026-11-22T10:00:00.250Z"}"#)
        XCTAssertNotNil(c.createdAt)
        XCTAssertEqual(c.createdAt.map { Int(($0.timeIntervalSince1970 * 1000).rounded()) % 1000 } ?? -1, 250)
        let none: AppCommand = try decode(#"{"seq":4,"type":"showAll"}"#)
        XCTAssertNil(none.createdAt)
    }
}
