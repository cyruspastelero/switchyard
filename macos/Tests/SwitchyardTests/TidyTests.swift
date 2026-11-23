import Foundation
import XCTest
@testable import Switchyard

final class TidyTests: XCTestCase {
    func test_an_unchanged_window_set_is_skipped_unless_forced() {
        XCTAssertFalse(TidyGate.shouldRun(keys: ["a", "b"], last: ["b", "a"], force: false))
        XCTAssertTrue(TidyGate.shouldRun(keys: ["a", "b", "c"], last: ["a", "b"], force: false))
        XCTAssertTrue(TidyGate.shouldRun(keys: ["a"], last: nil, force: false))
        XCTAssertTrue(TidyGate.shouldRun(keys: ["a", "b"], last: ["a", "b"], force: true))
    }

    func test_nothing_to_lay_out_never_runs() {
        XCTAssertFalse(TidyGate.shouldRun(keys: [], last: nil, force: true))
    }

    func test_before_frames_round_trip_through_the_file() {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("tidy-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let store = TidyStore(url: url)
        var memory = TidyMemory()
        memory.record(desktop: 2, before: ["a": Rect(x: 1, y: 2, width: 3, height: 4)], keys: ["a"])
        store.save(memory)
        let loaded = store.load()
        XCTAssertEqual(loaded, memory)
        XCTAssertEqual(loaded.lastKeys(desktop: 2), ["a"])
        XCTAssertTrue(loaded.canUndo(desktop: 2))
    }

    func test_undo_with_nothing_saved_is_a_no_op() {
        var memory = TidyMemory()
        XCTAssertEqual(memory.takeUndo(desktop: 3), [:])
        XCTAssertFalse(memory.canUndo(desktop: 3))
    }

    func test_undo_is_one_level_and_clears_after_use() {
        var memory = TidyMemory()
        memory.record(desktop: 1, before: ["a": Rect(x: 0, y: 0, width: 5, height: 5)], keys: ["a"])
        memory.record(desktop: 1, before: ["b": Rect(x: 9, y: 9, width: 5, height: 5)], keys: ["b"])
        XCTAssertEqual(memory.takeUndo(desktop: 1), ["b": Rect(x: 9, y: 9, width: 5, height: 5)])
        XCTAssertFalse(memory.canUndo(desktop: 1))
    }

    func test_a_second_tidy_of_untouched_windows_keeps_the_first_undo() {
        var memory = TidyMemory()
        let original = ["a": Rect(x: 0, y: 0, width: 5, height: 5), "b": Rect(x: 50, y: 0, width: 5, height: 5)]
        let tidied = ["a": Rect(x: 8, y: 45, width: 700, height: 900), "b": Rect(x: 716, y: 45, width: 700, height: 900)]
        memory.record(desktop: 1, before: original, keys: ["a", "b"])
        memory.recordResult(desktop: 1, after: tidied)
        let nudged = ["a": Rect(x: 9, y: 46, width: 701, height: 899), "b": tidied["b"]!]
        memory.record(desktop: 1, before: nudged, keys: ["a", "b"])
        XCTAssertEqual(memory.takeUndo(desktop: 1), original)
    }

    func test_a_tidy_after_the_owner_moved_a_window_takes_a_new_undo() {
        var memory = TidyMemory()
        let tidied = ["a": Rect(x: 8, y: 45, width: 700, height: 900)]
        memory.record(desktop: 1, before: ["a": Rect(x: 0, y: 0, width: 5, height: 5)], keys: ["a"])
        memory.recordResult(desktop: 1, after: tidied)
        let moved = ["a": Rect(x: 100, y: 45, width: 700, height: 900)]
        memory.record(desktop: 1, before: moved, keys: ["a"])
        XCTAssertEqual(memory.takeUndo(desktop: 1), moved)
    }

    func test_a_tidy_with_a_new_window_takes_a_new_undo() {
        var memory = TidyMemory()
        let tidied = ["a": Rect(x: 8, y: 45, width: 700, height: 900)]
        memory.record(desktop: 1, before: ["a": Rect(x: 0, y: 0, width: 5, height: 5)], keys: ["a"])
        memory.recordResult(desktop: 1, after: tidied)
        let now = ["a": tidied["a"]!, "b": Rect(x: 1, y: 1, width: 5, height: 5)]
        memory.record(desktop: 1, before: now, keys: ["a", "b"])
        XCTAssertEqual(memory.takeUndo(desktop: 1), now)
    }

    func test_a_tidy_file_from_before_results_were_kept_still_loads() throws {
        let old = #"{"before":{"2":{"a":{"x":1,"y":2,"width":3,"height":4}}},"sets":{"2":["a"]},"presets":{"2":""}}"#
        let memory = try JSONDecoder().decode(TidyMemory.self, from: Data(old.utf8))
        XCTAssertTrue(memory.canUndo(desktop: 2))
    }

    // MARK: which windows a desktop's tidy lays out

    private func ctx(_ id: String, desktop: Int?, shared: Bool = false, windows: [String]) -> ContextDTO {
        ContextDTO(id: id, name: id, key: nil, color: nil, status: "idle", windows: windows.map { WindowRef(key: $0) },
                   desktop: desktop, desktopShared: shared)
    }

    func test_a_project_desktop_lays_out_its_contexts_windows() {
        let contexts = [ctx("a", desktop: 2, windows: ["a1", "a2"]), ctx("b", desktop: 3, windows: ["b1"])]
        XCTAssertEqual(TidyTargets.keys(contexts: contexts, desktop: 2, activeContextId: nil), ["a1", "a2"])
    }

    func test_the_shared_desktop_lays_out_only_the_active_context() {
        let contexts = [ctx("a", desktop: 6, shared: true, windows: ["a1"]), ctx("b", desktop: 6, shared: true, windows: ["b1"])]
        XCTAssertEqual(TidyTargets.keys(contexts: contexts, desktop: 6, activeContextId: "b"), ["b1"])
        XCTAssertEqual(TidyTargets.keys(contexts: contexts, desktop: 6, activeContextId: nil), [])
    }

    func test_carried_windows_join_their_new_desktop_and_leave_the_old_one() {
        let contexts = [ctx("a", desktop: 1, windows: ["a1", "moved"]), ctx("b", desktop: 2, windows: ["b1"])]
        let moves = [WindowMoveDTO(windowKey: "moved", desktop: 2)]
        XCTAssertEqual(TidyTargets.keys(contexts: contexts, desktop: 2, activeContextId: nil, moves: moves), ["b1", "moved"])
        XCTAssertEqual(TidyTargets.keys(contexts: contexts, desktop: 1, activeContextId: nil, moves: moves), ["a1"])
    }

    func test_manual_tidy_takes_every_shown_window_whatever_its_context() {
        let windows: [ManualTidy.Candidate] = [
            .init(key: "mine", hidden: false), .init(key: "unsorted", hidden: false),
            .init(key: "other-context", hidden: false), .init(key: "hidden", hidden: true),
        ]
        XCTAssertEqual(ManualTidy.keys(windows), ["mine", "unsorted", "other-context"])
    }
}
