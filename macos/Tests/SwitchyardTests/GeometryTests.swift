import Foundation
import XCTest
@testable import Switchyard

final class GeometryTests: XCTestCase {
    private let screen = Rect(x: 0, y: 0, width: 1440, height: 900)

    func test_offscreen_origin_leaves_one_pixel_visible() {
        let o = FrameMath.offscreenOrigin(for: screen)
        XCTAssertEqual(o.x, 1439)
        XCTAssertEqual(o.y, 899)
    }

    func test_screen_is_chosen_by_window_center() {
        let right = Rect(x: 1440, y: 0, width: 1920, height: 1080)
        let win = Rect(x: 1500, y: 100, width: 800, height: 600)
        XCTAssertEqual(FrameMath.screen(containing: win, in: [screen, right]), right)
    }

    func test_cocoa_frames_flip_to_top_left_origin() {
        let second = Rect(x: 1440, y: 200, width: 1920, height: 1080) // above-right in Cocoa space
        let ax = FrameMath.fromCocoa(second, primaryHeight: 900)
        XCTAssertEqual(ax.y, 900 - 1280)
    }

    func test_parked_position_is_detected() {
        XCTAssertTrue(FrameMath.isParked(origin: (1439, 899), screens: [screen]))
        XCTAssertFalse(FrameMath.isParked(origin: (100, 100), screens: [screen]))
    }

    func test_restore_keeps_a_visible_frame() {
        let f = Rect(x: 100, y: 100, width: 800, height: 600)
        XCTAssertEqual(FrameMath.restorableFrame(f, screens: [screen]), f)
    }

    func test_restore_moves_a_frame_from_a_missing_screen_onto_the_first() {
        let gone = Rect(x: 5000, y: 100, width: 800, height: 600)
        let r = FrameMath.restorableFrame(gone, screens: [screen])
        XCTAssertTrue(screen.intersects(r))
    }

    func test_restore_never_returns_the_parked_frame() {
        let parked = Rect(x: 1439, y: 899, width: 800, height: 600)
        let r = FrameMath.restorableFrame(parked, screens: [screen])
        XCTAssertFalse(FrameMath.isParked(origin: (r.x, r.y), screens: [screen]))
    }
}
