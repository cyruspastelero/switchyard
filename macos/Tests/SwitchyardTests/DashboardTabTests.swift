import Foundation
import XCTest
@testable import Switchyard

final class DashboardTabTests: XCTestCase {
    private let server = URL(string: "http://127.0.0.1:4280")!
    private func tab(_ w: String, _ t: String, _ url: String) -> DashboardTabs.Tab {
        DashboardTabs.Tab(pid: 1, windowId: w, tabId: t, url: url)
    }

    func test_the_first_dashboard_tab_is_kept_and_the_other_dashboard_tabs_close() {
        let plan = DashboardTabs.plan([
            tab("w1", "1", "https://news.ycombinator.com/"),
            tab("w1", "2", "http://localhost:4280/"),
            tab("w2", "3", "http://127.0.0.1:4280/login"),
            tab("w2", "4", "http://localhost:3000/"),
        ], server: server)
        XCTAssertEqual(plan.keep, tab("w1", "2", "http://localhost:4280/"))
        XCTAssertEqual(plan.close, [tab("w2", "3", "http://127.0.0.1:4280/login")])
    }

    func test_other_ports_hosts_and_lookalikes_are_never_touched() {
        let plan = DashboardTabs.plan([
            tab("w1", "1", "http://localhost:42800/"),
            tab("w1", "2", "http://evil.example/?u=http://localhost:4280/"),
            tab("w1", "3", "https://localhost:4280/"),
        ], server: server)
        XCTAssertNil(plan.keep)
        XCTAssertEqual(plan.close, [])
    }
}
