import Foundation
import XCTest
@testable import Switchyard

/// Two Chrome processes can share one bundle id (the owner's Chrome and an automation Chrome).
final class BrowserInstanceTests: XCTestCase {
    private let real = BrowserInstance(kind: .chrome, pid: 20780)
    private let automation = BrowserInstance(kind: .chrome, pid: 1161)
    private let frame = Rect(x: 0, y: 0, width: 800, height: 600)

    private func window(_ id: String, pid: pid_t, title: String) -> BrowserWindow {
        BrowserWindow(bundleId: BrowserKind.chrome.rawValue, pid: pid, id: id, name: nil, activeTitle: title,
                      bounds: frame, tabs: [])
    }

    func test_a_browser_window_pairs_only_with_a_window_of_its_own_process() {
        let candidates = [
            BrowserCandidate(index: 0, bundleId: BrowserKind.chrome.rawValue, pid: 1161, title: "Docs", frame: frame),
            BrowserCandidate(index: 1, bundleId: BrowserKind.chrome.rawValue, pid: 20780, title: "Docs", frame: frame),
        ]
        let pairs = BrowserInstances.pair(candidates: candidates, browser: [window("w1", pid: 20780, title: "Docs")])
        XCTAssertEqual(pairs[1]?.id, "w1")
        XCTAssertNil(pairs[0])
    }

    func test_windows_from_two_instances_pair_independently() {
        let candidates = [
            BrowserCandidate(index: 0, bundleId: BrowserKind.chrome.rawValue, pid: 1161, title: "A", frame: frame),
            BrowserCandidate(index: 1, bundleId: BrowserKind.chrome.rawValue, pid: 20780, title: "B", frame: frame),
        ]
        let pairs = BrowserInstances.pair(candidates: candidates,
                                          browser: [window("b", pid: 20780, title: "B"), window("a", pid: 1161, title: "A")])
        XCTAssertEqual(pairs[0]?.id, "a")
        XCTAssertEqual(pairs[1]?.id, "b")
    }

    func test_a_hung_instance_does_not_stop_the_other_from_being_asked() {
        let now = Date()
        let due = BrowserInstances.due([automation, real], inFlight: [automation], retryAt: [:], now: now)
        XCTAssertEqual(due, [real])
    }

    func test_an_instance_waiting_out_its_backoff_is_not_asked_but_others_are() {
        let now = Date()
        let due = BrowserInstances.due([automation, real], inFlight: [], retryAt: [automation: now.addingTimeInterval(60)], now: now)
        XCTAssertEqual(due, [real])
    }

    func test_a_new_window_opens_in_the_instance_that_answers() {
        let old = Date(timeIntervalSince1970: 0), newer = Date(timeIntervalSince1970: 100)
        let pid = BrowserInstances.forNewWindow(running: [(1161, newer), (20780, old)], answering: [20780: 2])
        XCTAssertEqual(pid, 20780)
    }

    func test_a_new_window_prefers_the_instance_with_more_windows_when_both_answer() {
        let pid = BrowserInstances.forNewWindow(running: [(1161, nil), (20780, nil)], answering: [1161: 1, 20780: 3])
        XCTAssertEqual(pid, 20780)
    }

    func test_with_no_answers_a_new_window_opens_in_the_newest_instance() {
        let old = Date(timeIntervalSince1970: 0), newer = Date(timeIntervalSince1970: 100)
        XCTAssertEqual(BrowserInstances.forNewWindow(running: [(1161, old), (20780, newer)], answering: [:]), 20780)
        XCTAssertNil(BrowserInstances.forNewWindow(running: [], answering: [:]))
    }
}
