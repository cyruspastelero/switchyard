import AppKit
import Foundation
import XCTest
@testable import Switchyard

final class HardeningTests: XCTestCase {
    private func permissions(_ url: URL) throws -> Int {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        return (attributes[.posixPermissions] as? NSNumber)?.intValue ?? -1
    }

    /// A folder the store will create (not created here).
    private func scratchFolder() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("switchyard-hardening-\(UUID().uuidString)")
            .appendingPathComponent("Switchyard")
    }

    private func record() -> HiddenRecord {
        HiddenRecord(key: "k", pid: 1, bundleId: "b", title: "secret title", frame: Rect(x: 0, y: 0, width: 10, height: 10))
    }

    func test_hidden_windows_file_is_owner_only_inside_an_owner_only_folder() throws {
        let folder = scratchFolder()
        defer { try? FileManager.default.removeItem(at: folder.deletingLastPathComponent()) }
        let url = folder.appendingPathComponent("hidden-windows.json")
        HiddenStore(url: url).save([record()])
        XCTAssertEqual(try permissions(url), 0o600)
        XCTAssertEqual(try permissions(folder), 0o700)
        XCTAssertEqual(HiddenStore(url: url).load(), [record()])
    }

    func test_rewriting_a_world_readable_hidden_windows_file_leaves_it_owner_only_and_no_temp_files() throws {
        let folder = scratchFolder()
        defer { try? FileManager.default.removeItem(at: folder.deletingLastPathComponent()) }
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent("hidden-windows.json")
        // As an older build left it.
        XCTAssertTrue(FileManager.default.createFile(atPath: url.path, contents: Data("[]".utf8), attributes: [.posixPermissions: 0o644]))
        HiddenStore(url: url).save([record()])
        XCTAssertEqual(try permissions(url), 0o600)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.path), ["hidden-windows.json"])
    }

    func test_tidy_file_is_owner_only_inside_an_owner_only_folder() throws {
        let folder = scratchFolder()
        defer { try? FileManager.default.removeItem(at: folder.deletingLastPathComponent()) }
        let url = folder.appendingPathComponent("tidy.json")
        TidyStore(url: url).save(TidyMemory())
        XCTAssertEqual(try permissions(url), 0o600)
        XCTAssertEqual(try permissions(folder), 0o700)
    }

    func test_copied_access_code_is_marked_concealed_and_transient_for_clipboard_managers() {
        let board = NSPasteboard(name: NSPasteboard.Name("switchyard-test-\(UUID().uuidString)"))
        board.setSecret("123456")
        XCTAssertEqual(board.string(forType: .string), "123456")
        let types = board.types ?? []
        XCTAssertTrue(types.contains(NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")))
        XCTAssertTrue(types.contains(NSPasteboard.PasteboardType("org.nspasteboard.TransientType")))
        board.releaseGlobally()
    }

    func test_a_failure_after_the_window_was_made_says_the_window_exists() {
        struct Stall: Error, LocalizedError { var errorDescription: String? { "Chrome did not answer in time" } }
        var message = ""
        do { try ChromeBridge.afterWindowOpened("loading the first URL") { throw Stall() } } catch {
            message = error.localizedDescription
        }
        XCTAssertTrue(message.hasPrefix("opened the window"), message)
        XCTAssertTrue(message.contains("loading the first URL"), message)
        XCTAssertTrue(message.contains("Chrome did not answer in time"), message)
    }

    func test_scripting_setter_selector_follows_key_value_coding() {
        XCTAssertEqual(ChromeBridge.setterName("givenName"), "setGivenName:")
        XCTAssertEqual(ChromeBridge.setterName("URL"), "setURL:")
        XCTAssertEqual(ChromeBridge.setterName("activeTabIndex"), "setActiveTabIndex:")
    }
}
