import Foundation
import XCTest
@testable import Switchyard

final class ReliabilityTests: XCTestCase {
    private func decode<T: Decodable>(_ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    private func record(_ key: String, pid: Int32) -> HiddenRecord {
        HiddenRecord(key: key, pid: pid, bundleId: "b", title: "t", frame: Rect(x: 0, y: 0, width: 10, height: 10))
    }

    // MARK: show

    func test_show_command_carries_the_windows_to_hide_and_the_focus_flag() throws {
        let c: AppCommand = try decode(#"{"seq":3,"type":"show","contextId":"c","windowKeys":["a"],"hideKeys":["b"],"focus":false}"#)
        XCTAssertEqual(c.hideKeys ?? [], ["b"])
        XCTAssertFalse(c.focus)
        let plain: AppCommand = try decode(#"{"seq":4,"type":"show","contextId":"c","windowKeys":[],"hideKeys":[]}"#)
        XCTAssertTrue(plain.focus)
    }

    func test_show_without_a_hide_list_is_refused_instead_of_hiding_every_window() throws {
        let c: AppCommand = try decode(#"{"seq":3,"type":"show","contextId":"c","windowKeys":["a"]}"#)
        var refused = false
        do { _ = try ShowPlan.sets(for: c) } catch { refused = true }
        XCTAssertTrue(refused)
    }

    func test_show_hides_only_listed_windows_and_never_a_shown_one() throws {
        let c: AppCommand = try decode(#"{"seq":3,"type":"show","contextId":"c","windowKeys":["a","both"],"hideKeys":["b","both"]}"#)
        let sets = try ShowPlan.sets(for: c)
        XCTAssertTrue(ShowPlan.hides("b", sets))
        XCTAssertFalse(ShowPlan.hides("a", sets))
        XCTAssertFalse(ShowPlan.hides("both", sets))
        XCTAssertFalse(ShowPlan.hides("unsorted", sets))
    }

    // MARK: hidden windows

    func test_a_hidden_window_on_another_desktop_is_remembered_while_its_app_runs() {
        let hidden = ["here": record("here", pid: 1), "otherSpace": record("otherSpace", pid: 2), "quitApp": record("quitApp", pid: 3)]
        let kept = HiddenRecords.surviving(hidden, listed: ["here"], runningPids: [1, 2])
        XCTAssertEqual(Set(kept.keys), ["here", "otherSpace"])
    }

    // MARK: browsers

    func test_a_failing_browser_is_asked_less_and_less_often() {
        XCTAssertEqual(BrowserBackoff.delay(afterFailures: 0), 0)
        XCTAssertEqual(BrowserBackoff.delay(afterFailures: 1), 15)
        XCTAssertEqual(BrowserBackoff.delay(afterFailures: 2), 30)
        XCTAssertEqual(BrowserBackoff.delay(afterFailures: 3), 60)
        XCTAssertEqual(BrowserBackoff.delay(afterFailures: 40), 300)
    }

    // MARK: menu

    func test_access_code_response_decodes() throws {
        let r: AccessCodeResponse = try decode(#"{"accessCode":"123456"}"#)
        XCTAssertEqual(r.accessCode, "123456")
    }

    func test_menu_says_what_is_wrong_and_what_to_do() {
        XCTAssertEqual(MenuStatus.lines(serverProblem: "Server not reachable", trusted: true, contextCount: 0),
                       ["Server not reachable", "Start it with: switchyard install-service"])
        XCTAssertEqual(MenuStatus.lines(serverProblem: nil, trusted: false, contextCount: 2),
                       ["Windows can't be moved yet", "Allow Switchyard under Privacy & Security › Accessibility"])
        XCTAssertEqual(MenuStatus.lines(serverProblem: nil, trusted: true, contextCount: 0),
                       ["No contexts yet", "Start Claude Code in a project folder and it appears here"])
        XCTAssertEqual(MenuStatus.lines(serverProblem: nil, trusted: true, contextCount: 3), [])
    }
}
