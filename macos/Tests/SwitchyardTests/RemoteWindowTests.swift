import Foundation
import XCTest
@testable import Switchyard

/// Windows on other desktops, found at launch without visiting them.
final class RemoteWindowTests: XCTestCase {
    private func cg(_ n: UInt32, pid: Int32, layer: Int = 0, w: Double = 800, h: Double = 600) -> CGWindowInfo {
        CGWindowInfo(number: n, pid: pid, layer: layer, bounds: Rect(x: 0, y: 0, width: w, height: h))
    }

    func test_windows_on_other_desktops_that_no_listing_has_are_looked_up_per_app() {
        let wanted = RemoteWindows.missing(windows: [cg(1, pid: 10), cg(2, pid: 10), cg(3, pid: 20), cg(4, pid: 10)],
                                           desktopOf: [1: 2, 2: 1, 3: 3, 4: 2], known: [4], livePids: [10, 20], active: 1)
        XCTAssertEqual(wanted, [10: [1], 20: [3]])
    }

    func test_menus_panels_tiny_windows_and_other_processes_are_ignored() {
        let wanted = RemoteWindows.missing(windows: [cg(1, pid: 10, layer: 25), cg(2, pid: 10, w: 20, h: 20), cg(3, pid: 99)],
                                           desktopOf: [1: 2, 2: 2, 3: 2], known: [], livePids: [10], active: 1)
        XCTAssertEqual(wanted, [:])
    }

    func test_windows_on_no_desktop_or_with_no_active_desktop_are_not_looked_up() {
        XCTAssertEqual(RemoteWindows.missing(windows: [cg(1, pid: 10)], desktopOf: [:], known: [], livePids: [10], active: 1), [:])
        XCTAssertEqual(RemoteWindows.missing(windows: [cg(1, pid: 10)], desktopOf: [1: 2], known: [], livePids: [10], active: nil), [:])
    }

    func test_the_remote_token_is_pid_zero_coco_and_the_element_id_little_endian() {
        let bytes = [UInt8](RemoteWindows.token(pid: 0x0102, elementId: 7))
        XCTAssertEqual(bytes.count, 20)
        XCTAssertEqual(Array(bytes[0..<4]), [0x02, 0x01, 0, 0])
        XCTAssertEqual(Array(bytes[4..<8]), [0, 0, 0, 0])
        XCTAssertEqual(Array(bytes[8..<12]), [0x6f, 0x63, 0x6f, 0x63]) // 'coco'
        XCTAssertEqual(Array(bytes[12..<20]), [7, 0, 0, 0, 0, 0, 0, 0])
    }

    func test_a_window_number_that_failed_is_not_searched_again_until_the_retry_time() {
        var tries = RemoteRetry()
        let now = Date()
        tries.failed([5], at: now)
        XCTAssertFalse(tries.shouldTry(5, now: now.addingTimeInterval(10)))
        XCTAssertTrue(tries.shouldTry(5, now: now.addingTimeInterval(RemoteRetry.wait + 1)))
        XCTAssertTrue(tries.shouldTry(6, now: now))
    }

}
