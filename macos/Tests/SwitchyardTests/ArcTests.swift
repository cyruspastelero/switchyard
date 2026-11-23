import Foundation
import XCTest
@testable import Switchyard

final class ArcTests: XCTestCase {
    private let us = "\u{1F}", rs = "\u{1E}"

    func test_arc_listing_parses_windows_and_their_tabs() {
        let text = "W\(us)W1\(us)Personal\(rs)T\(us)t1\(us)https://a.dev\(us)A\(rs)T\(us)t2\(us)https://b.dev\(us)B\(rs)W\(us)W2\(us)Work\(rs)"
        XCTAssertEqual(ArcScripts.parse(text), [
            .init(id: "W1", name: "Personal", tabs: [BrowserTab(id: "t1", url: "https://a.dev", title: "A"),
                                                     BrowserTab(id: "t2", url: "https://b.dev", title: "B")]),
            .init(id: "W2", name: "Work", tabs: []),
        ])
    }

    func test_tab_titles_containing_tabs_and_newlines_survive() {
        let text = "W\(us)W1\(us)\(rs)T\(us)t1\(us)https://a.dev\(us)line one\nline\ttwo\(rs)"
        XCTAssertEqual(ArcScripts.parse(text).first?.tabs.first?.title, "line one\nline\ttwo")
        XCTAssertNil(ArcScripts.parse(text).first?.name)
    }

    func test_the_arc_script_names_arc_in_its_text_so_arcs_terminology_loads() {
        // `tell application id (item 1 of argv)` compiles without Arc's dictionary: Arc answers -1728.
        XCTAssertTrue(ArcScripts.list.contains("tell application id \"company.thebrowser.Browser\""))
        XCTAssertFalse(ArcScripts.list.contains("item 1 of argv"))
    }

    func test_empty_output_means_no_windows() {
        XCTAssertEqual(ArcScripts.parse(""), [])
    }

    func test_a_single_leftover_window_without_bounds_is_matched() {
        let axs = [AXWindowInfo(index: 0, title: "Gmail", frame: Rect(x: 0, y: 0, width: 800, height: 600))]
        let bs = [BrowserWindowInfo(id: "arc-1", name: nil, activeTitle: "Personal", bounds: nil)]
        XCTAssertEqual(WindowMatching.match(ax: axs, browser: bs), ["arc-1": 0])
    }
}
