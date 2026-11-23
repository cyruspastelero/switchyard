import CoreGraphics
import Foundation
import XCTest
@testable import Switchyard

/// Where a carry grabs a window. Kept from the carry spike, which proved these points live.
final class CarryGrabTests: XCTestCase {

    func test_grab_point_sits_right_of_zoom_button_and_5px_down() {
        let window = Rect(x: 100, y: 200, width: 800, height: 600)
        let zoom = Rect(x: 152, y: 206, width: 14, height: 16)
        XCTAssertEqual(CarryGrab.point(zoomButton: zoom, window: window), .success(CGPoint(x: 172, y: 205)))
    }

    func test_no_zoom_button_means_no_title_bar() {
        let window = Rect(x: 0, y: 0, width: 800, height: 600)
        XCTAssertEqual(CarryGrab.point(zoomButton: nil, window: window), .failure(.noTitleBar))
        XCTAssertEqual(CarryGrab.point(zoomButton: Rect(x: 0, y: 0, width: 0, height: 0), window: window), .failure(.noTitleBar))
    }

    func test_grab_point_outside_the_window_is_refused() {
        let window = Rect(x: 0, y: 0, width: 60, height: 600)
        XCTAssertEqual(CarryGrab.point(zoomButton: Rect(x: 46, y: 6, width: 14, height: 16), window: window), .failure(.outsideWindow))
    }

    // MARK: grab candidates

    private let screen = Rect(x: 0, y: 0, width: 1470, height: 956)

    func test_candidates_try_the_title_bar_first_then_the_window_edges() {
        let window = Rect(x: 100, y: 200, width: 800, height: 600)
        let zoom = Rect(x: 152, y: 206, width: 14, height: 16)
        XCTAssertEqual(CarryGrab.candidates(zoomButton: zoom, window: window, screens: [screen], preferred: nil), [
            CarryGrabCandidate(kind: .titleBar, point: CGPoint(x: 172, y: 205), dragX: 1, dragY: 0),
            CarryGrabCandidate(kind: .leftEdge, point: CGPoint(x: 101, y: 500), dragX: 0, dragY: 1),
            CarryGrabCandidate(kind: .rightEdge, point: CGPoint(x: 898, y: 500), dragX: 0, dragY: 1),
            CarryGrabCandidate(kind: .topEdge, point: CGPoint(x: 500, y: 201), dragX: 1, dragY: 0),
            CarryGrabCandidate(kind: .leftEdgeOption, point: CGPoint(x: 101, y: 500), dragX: 0, dragY: 1),
        ])
    }

    func test_window_without_a_zoom_button_still_gets_edge_candidates() {
        let window = Rect(x: 404, y: 37, width: 1066, height: 918)
        let kinds = CarryGrab.candidates(zoomButton: nil, window: window, screens: [screen], preferred: nil).map(\.kind)
        XCTAssertEqual(kinds, [.leftEdge, .rightEdge, .topEdge, .leftEdgeOption])
    }

    func test_the_kind_that_worked_before_is_tried_first() {
        let window = Rect(x: 100, y: 200, width: 800, height: 600)
        let zoom = Rect(x: 152, y: 206, width: 14, height: 16)
        let kinds = CarryGrab.candidates(zoomButton: zoom, window: window, screens: [screen], preferred: .rightEdge).map(\.kind)
        XCTAssertEqual(kinds, [.rightEdge, .titleBar, .leftEdge, .topEdge, .leftEdgeOption])
    }

    func test_window_parked_off_screen_has_no_candidates() {
        let parked = Rect(x: 1469, y: 915, width: 849, height: 919)
        let zoom = Rect(x: 1521, y: 921, width: 14, height: 16)
        XCTAssertEqual(CarryGrab.candidates(zoomButton: zoom, window: parked, screens: [screen], preferred: nil), [])
    }

    func test_edge_points_past_the_screen_edge_are_dropped() {
        let window = Rect(x: -20, y: 100, width: 800, height: 600)
        let kinds = CarryGrab.candidates(zoomButton: nil, window: window, screens: [screen], preferred: nil).map(\.kind)
        XCTAssertEqual(kinds, [.rightEdge, .topEdge])
    }

    func test_only_the_option_variant_holds_option() {
        XCTAssertEqual(CarryGrabKind.allCases.filter(\.holdsOption), [.leftEdgeOption])
    }

    func test_drag_started_when_the_window_moved_and_kept_its_size() {
        let before = Rect(x: 100, y: 200, width: 800, height: 600)
        XCTAssertTrue(CarryGrab.dragStarted(before: before, after: Rect(x: 100, y: 212, width: 800, height: 600)))
        XCTAssertTrue(CarryGrab.dragStarted(before: before, after: Rect(x: 112, y: 200, width: 800, height: 600)))
    }

    func test_drag_not_started_when_the_window_stayed_or_resized() {
        let before = Rect(x: 100, y: 200, width: 800, height: 600)
        XCTAssertFalse(CarryGrab.dragStarted(before: before, after: before))
        XCTAssertFalse(CarryGrab.dragStarted(before: before, after: Rect(x: 100, y: 212, width: 800, height: 588)))
    }

    func test_drag_path_goes_out_along_the_direction_and_ends_at_the_grab_point() {
        let c = CarryGrabCandidate(kind: .leftEdge, point: CGPoint(x: 101, y: 500), dragX: 0, dragY: 1)
        XCTAssertEqual(CarryGrab.dragOut(c), [CGPoint(x: 101, y: 504), CGPoint(x: 101, y: 508), CGPoint(x: 101, y: 512)])
        XCTAssertEqual(CarryGrab.dragBack(c), [CGPoint(x: 101, y: 506), CGPoint(x: 101, y: 500)])
    }


    func test_the_grab_that_worked_is_remembered_across_launches() {
        let suite = "ph.pastelero.switchyard.tests"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        defer { defaults.removePersistentDomain(forName: suite) }
        CarryGrabMemory(defaults: defaults).remember(.topEdge, for: "com.mitchellh.ghostty")
        XCTAssertEqual(CarryGrabMemory(defaults: defaults).kind(for: "com.mitchellh.ghostty"), .topEdge)
        XCTAssertNil(CarryGrabMemory(defaults: defaults).kind(for: "com.apple.finder"))
    }
}
