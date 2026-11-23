import Foundation
import XCTest
@testable import Switchyard

final class LayoutTests: XCTestCase {
    /// The audited screen: 1470 × 956, 37 px menu bar, Dock hidden.
    private let area = Rect(x: 0, y: 37, width: 1470, height: 919)

    private func inside(_ r: Rect, _ a: Rect) -> Bool {
        r.x >= a.x && r.y >= a.y && r.maxX <= a.maxX && r.maxY <= a.maxY
    }

    // MARK: frames

    func test_one_window_fills_the_area_inside_the_gap() {
        XCTAssertEqual(Layout.frames(count: 1, area: area, gap: 8), [Rect(x: 8, y: 45, width: 1454, height: 903)])
    }

    func test_two_windows_split_sixty_forty_with_one_gap_and_no_overlap() {
        let f = Layout.frames(count: 2, area: area, gap: 8)
        XCTAssertEqual(f.count, 2)
        XCTAssertEqual(f[0].width + f[1].width, 1446)
        XCTAssertEqual(f[0].width, 868)
        XCTAssertEqual(f[1].x, f[0].maxX + 8)
        XCTAssertEqual(f[0].y, f[1].y)
        XCTAssertEqual(f[0].height, f[1].height)
        XCTAssertFalse(f[0].intersects(f[1]))
    }

    func test_three_and_four_windows_stack_equal_heights_on_the_right() {
        for count in [3, 4] {
            let f = Layout.frames(count: count, area: area, gap: 8)
            let right = Array(f.dropFirst())
            XCTAssertEqual(right.count, count - 1)
            XCTAssertEqual(Set(right.map(\.height)).count, 1, "equal heights for \(count)")
            for (a, b) in zip(right, right.dropFirst()) { XCTAssertEqual(b.y, a.maxY + 8) }
            XCTAssertTrue(right.allSatisfy { inside($0, area) })
            XCTAssertTrue(right.last!.maxY <= area.maxY - 8)
        }
    }

    func test_five_or_more_windows_form_a_deck_stepping_thirty_px_with_one_bottom_edge() {
        for count in [5, 7] {
            let deck = Array(Layout.frames(count: count, area: area, gap: 8).dropFirst())
            XCTAssertEqual(deck.count, count - 1)
            for (a, b) in zip(deck, deck.dropFirst()) { XCTAssertEqual(b.y - a.y, 30) }
            XCTAssertEqual(Set(deck.map(\.maxY)).count, 1)
            XCTAssertEqual(Set(deck.map(\.width)).count, 1)
            XCTAssertTrue(deck.allSatisfy { inside($0, area) })
        }
    }

    func test_every_count_up_to_twelve_stays_inside_and_puts_the_main_window_left() {
        for count in 1...12 {
            let f = Layout.frames(count: count, area: area, gap: 8)
            XCTAssertEqual(f.count, count)
            XCTAssertTrue(f.allSatisfy { inside($0, area) }, "inside for \(count)")
            XCTAssertEqual(f.map(\.x).min(), f[0].x)
        }
    }

    func test_no_windows_gives_no_frames() {
        XCTAssertEqual(Layout.frames(count: 0, area: area, gap: 8), [])
    }

    func test_dock_on_the_left_shifts_everything_by_its_width() {
        let shifted = Rect(x: 70, y: 37, width: 1400, height: 919)
        let f = Layout.frames(count: 3, area: shifted, gap: 8)
        XCTAssertEqual(f[0].x, 78)
        XCTAssertTrue(f.allSatisfy { inside($0, shifted) })
    }

    func test_a_screen_with_negative_x_works() {
        let left = Rect(x: -1920, y: 0, width: 1920, height: 1080)
        let f = Layout.frames(count: 2, area: left, gap: 8)
        XCTAssertEqual(f[0].x, -1912)
        XCTAssertTrue(f.allSatisfy { inside($0, left) })
    }

    func test_area_converts_the_cocoa_visible_frame_to_accessibility_coordinates() {
        // Cocoa: origin bottom-left. A 956 px screen with a 37 px menu bar has visibleFrame y 0, height 919.
        XCTAssertEqual(Layout.area(visibleFrame: Rect(x: 0, y: 0, width: 1470, height: 919), primaryHeight: 956), area)
    }

    // MARK: windows that refuse their slot

    func test_a_window_wider_than_its_slot_is_pulled_back_inside_the_area() {
        let slot = Rect(x: 884, y: 45, width: 578, height: 903)
        let got = Rect(x: 884, y: 45, width: 940, height: 903)
        XCTAssertEqual(Layout.fit(got, slot: slot, area: area), Rect(x: 1470 - 8 - 940, y: 45, width: 940, height: 903))
    }

    func test_a_window_that_took_its_slot_is_left_alone() {
        let slot = Rect(x: 8, y: 45, width: 868, height: 903)
        XCTAssertEqual(Layout.fit(slot, slot: slot, area: area), slot)
    }

    // MARK: main window

    private func w(_ key: String, _ bundle: String, z: Int, n: UInt32 = 1) -> LayoutWindow {
        LayoutWindow(key: key, bundleId: bundle, z: z, number: n)
    }

    func test_the_browser_window_is_main_and_the_rest_go_front_to_back() {
        let order = Layout.pickMain([w("g1", "com.mitchellh.ghostty", z: 0), w("c", "com.google.Chrome", z: 1), w("g2", "com.mitchellh.ghostty", z: 2)])
        XCTAssertEqual(order, ["c", "g1", "g2"])
    }

    func test_with_two_browsers_the_front_most_is_main() {
        let order = Layout.pickMain([w("arc", "company.thebrowser.Browser", z: 3), w("c", "com.google.Chrome", z: 1), w("g", "x", z: 0)])
        XCTAssertEqual(order.first, "c")
    }

    func test_without_a_browser_the_front_most_window_is_main() {
        XCTAssertEqual(Layout.pickMain([w("b", "x", z: 4), w("a", "y", z: 2)]), ["a", "b"])
    }

    func test_ties_in_z_order_fall_back_to_window_number_and_the_same_input_gives_the_same_order() {
        let input = [w("b", "x", z: 1, n: 9), w("a", "x", z: 1, n: 3)]
        XCTAssertEqual(Layout.pickMain(input), ["a", "b"])
        XCTAssertEqual(Layout.pickMain(input), Layout.pickMain(input.reversed()))
    }

    // MARK: windows with a minimum size

    func test_a_right_window_with_a_minimum_size_widens_the_column_and_takes_its_height() {
        // Discord will not go below 800 × 500.
        let f = Layout.frames(count: 3, area: area, gap: 8, minimums: [2: Size(width: 800, height: 500)])
        XCTAssertEqual(f[2].width, 800)
        XCTAssertEqual(f[2].height, 500)
        XCTAssertEqual(f[1].width, 800)
        XCTAssertEqual(f[0].width, 1446 - 800)
        for i in f.indices { for j in f.indices where j > i { XCTAssertFalse(f[i].intersects(f[j]), "\(i) \(j)") } }
        XCTAssertTrue(f.allSatisfy { inside($0, area) })
    }

    func test_a_minimum_that_fits_its_slot_changes_nothing() {
        XCTAssertEqual(Layout.frames(count: 3, area: area, gap: 8, minimums: [1: Size(width: 100, height: 100)]),
                       Layout.frames(count: 3, area: area, gap: 8))
    }

    func test_the_main_window_keeps_at_least_forty_percent() {
        let f = Layout.frames(count: 2, area: area, gap: 8, minimums: [1: Size(width: 1300, height: 100)])
        XCTAssertTrue(f[0].width >= (1446 * 0.4).rounded(.down))
        XCTAssertFalse(f[0].intersects(f[1]))
    }

    func test_minimums_come_from_windows_that_stayed_larger_than_their_slot() {
        let slots = [Rect(x: 0, y: 0, width: 100, height: 100), Rect(x: 0, y: 0, width: 50, height: 50)]
        let got = [Rect(x: 0, y: 0, width: 96, height: 100), Rect(x: 0, y: 0, width: 80, height: 40)]
        XCTAssertEqual(Layout.minimums(slots: slots, got: got), [1: Size(width: 80, height: 50)])
    }

    func test_a_stack_whose_minimum_heights_cannot_fit_becomes_a_deck() {
        // Finder 308, VS Code 270 and Discord 500 high do not fit one above the other in 903 px.
        let mins = [1: Size(width: 800, height: 308), 2: Size(width: 800, height: 270), 3: Size(width: 800, height: 500)]
        let right = Array(Layout.frames(count: 4, area: area, gap: 8, minimums: mins).dropFirst())
        for (a, b) in zip(right, right.dropFirst()) { XCTAssertEqual(b.y - a.y, 30) }
        XCTAssertEqual(Set(right.map(\.maxY)).count, 1)
        XCTAssertTrue(zip(right, [308.0, 270, 500]).allSatisfy { $0.height >= $1 })
    }
}
