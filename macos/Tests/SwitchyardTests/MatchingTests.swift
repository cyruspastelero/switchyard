import Foundation
import XCTest
@testable import Switchyard

final class MatchingTests: XCTestCase {
    private func ax(_ i: Int, _ title: String, _ x: Double, _ y: Double = 0, w: Double = 800, h: Double = 600) -> AXWindowInfo {
        AXWindowInfo(index: i, title: title, frame: Rect(x: x, y: y, width: w, height: h))
    }

    func test_windows_match_by_frame() {
        let axs = [ax(0, "A", 0), ax(1, "B", 900)]
        let bs = [BrowserWindowInfo(id: "11", name: nil, activeTitle: "zzz", bounds: Rect(x: 901, y: 0, width: 800, height: 600))]
        XCTAssertEqual(WindowMatching.match(ax: axs, browser: bs), ["11": 1])
    }

    func test_same_frame_windows_are_told_apart_by_title() {
        let axs = [ax(0, "Inbox - Google Chrome", 0), ax(1, "Tala docs - Google Chrome", 0)]
        let bs = [BrowserWindowInfo(id: "1", name: nil, activeTitle: "Tala docs", bounds: Rect(x: 0, y: 0, width: 800, height: 600)),
                  BrowserWindowInfo(id: "2", name: nil, activeTitle: "Inbox", bounds: Rect(x: 0, y: 0, width: 800, height: 600))]
        XCTAssertEqual(WindowMatching.match(ax: axs, browser: bs), ["1": 1, "2": 0])
    }

    func test_given_name_matches_when_bounds_are_missing() {
        let axs = [ax(0, "Switchyard - Google Chrome", 0), ax(1, "Other", 50)]
        let bs = [BrowserWindowInfo(id: "9", name: "Switchyard", activeTitle: nil, bounds: nil)]
        XCTAssertEqual(WindowMatching.match(ax: axs, browser: bs), ["9": 0])
    }

    func test_unmatched_browser_window_is_left_out() {
        let bs = [BrowserWindowInfo(id: "1", name: nil, activeTitle: "Nope", bounds: Rect(x: 5000, y: 0, width: 10, height: 10))]
        XCTAssertTrue(WindowMatching.match(ax: [ax(0, "Else", 0)], browser: bs).isEmpty)
    }

    func test_one_ax_window_is_never_used_twice() {
        let r = Rect(x: 0, y: 0, width: 800, height: 600)
        let bs = [BrowserWindowInfo(id: "1", name: nil, activeTitle: "T", bounds: r), BrowserWindowInfo(id: "2", name: nil, activeTitle: "T", bounds: r)]
        let m = WindowMatching.match(ax: [ax(0, "T", 0)], browser: bs)
        XCTAssertEqual(m.count, 1)
    }

    func test_window_keys_use_the_window_number_so_a_changing_title_keeps_the_key() {
        let a = WindowKeys.make(bundleId: "com.mitchellh.ghostty", pid: 7, windowNumber: 42, title: "◐ Working", document: "/a", taken: [])
        let b = WindowKeys.make(bundleId: "com.mitchellh.ghostty", pid: 7, windowNumber: 42, title: "✳ Done", document: "/b", taken: [])
        XCTAssertEqual(a, "com.mitchellh.ghostty|w7.42")
        XCTAssertEqual(a, b)
        // Another process (after a reboot) reusing the same window number is a different window.
        XCTAssertNotEqual(a, WindowKeys.make(bundleId: "com.mitchellh.ghostty", pid: 8, windowNumber: 42, title: "x", document: nil, taken: []))
    }

    func test_without_a_window_number_keys_fall_back_to_the_title_with_a_suffix_for_duplicates() {
        let a = WindowKeys.make(bundleId: "b", pid: 1, windowNumber: nil, title: "t", document: nil, taken: [])
        let b = WindowKeys.make(bundleId: "b", pid: 1, windowNumber: nil, title: "t", document: nil, taken: [a])
        XCTAssertEqual(a, "b|t|")
        XCTAssertEqual(b, "b|t|#2")
    }

    func test_document_urls_become_paths() {
        XCTAssertEqual(WindowLayer.documentPath("file:///Users/me/proj/a%20b.txt"), "/Users/me/proj/a b.txt")
        XCTAssertNil(WindowLayer.documentPath(""))
    }
}
