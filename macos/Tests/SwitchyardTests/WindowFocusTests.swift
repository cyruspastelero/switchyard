import AppKit
import Foundation
import XCTest
@testable import Switchyard

final class WindowFocusTests: XCTestCase {
    private func decode<T: Decodable>(_ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    // MARK: focusWindow

    func test_focus_window_runs_in_the_fast_window_lane() {
        XCTAssertEqual(CommandLane.of("focusWindow"), .windows)
    }

    func test_focus_window_command_carries_its_window_key() throws {
        let c: AppCommand = try decode(#"{"seq":9,"type":"focusWindow","windowKey":"com.google.Chrome|w1.2"}"#)
        XCTAssertEqual(c.type, "focusWindow")
        XCTAssertEqual(c.windowKey, "com.google.Chrome|w1.2")
    }

    func test_focus_goes_to_the_windows_desktop_only_when_it_is_another_one() {
        XCTAssertEqual(FocusPlan.desktopToVisit(window: 5, active: 1), 5)
        XCTAssertNil(FocusPlan.desktopToVisit(window: 1, active: 1))
        XCTAssertNil(FocusPlan.desktopToVisit(window: nil, active: 1))
        XCTAssertEqual(FocusPlan.desktopToVisit(window: 3, active: nil), 3)
    }

    // MARK: other-desktop cache

    func test_windows_on_other_desktops_are_remembered_while_alive_even_when_no_desktop_is_active() {
        XCTAssertEqual(DesktopMerge.keep(cached: [7], listed: [], alive: [7], desktopOf: [7: 5], active: nil), [])
        XCTAssertEqual(DesktopMerge.remembered(cached: [7, 8], alive: [7]), [7])
    }

    // MARK: app icons

    func test_an_app_icon_becomes_a_small_retina_png() throws {
        let icon = NSWorkspace.shared.icon(forFile: "/System/Applications/Calculator.app")
        let data = try XCTUnwrapShim(AppIcons.png(from: icon))
        XCTAssertTrue(data.count <= AppIcons.maxBytes)
        XCTAssertEqual(Array(data.prefix(4)), [0x89, 0x50, 0x4E, 0x47])
        let rep = try XCTUnwrapShim(NSBitmapImageRep(data: data))
        XCTAssertEqual(rep.pixelsWide, 64)
        XCTAssertEqual(rep.pixelsHigh, 64)
    }

    func test_each_bundle_id_is_uploaded_once_per_launch() {
        var uploads = IconUploads()
        XCTAssertEqual(uploads.take(["a.b", "c.d", "a.b"]), ["a.b", "c.d"])
        XCTAssertEqual(uploads.take(["a.b", "e.f"]), ["e.f"])
        uploads.retry("e.f")
        XCTAssertEqual(uploads.take(["e.f"]), ["e.f"])
    }
}

private struct Missing: Error {}
private func XCTUnwrapShim<T>(_ v: T?) throws -> T {
    guard let v else { throw Missing() }
    return v
}
