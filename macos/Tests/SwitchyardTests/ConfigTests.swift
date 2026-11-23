import Foundation
import XCTest
@testable import Switchyard

final class ConfigTests: XCTestCase {
    private let home = URL(fileURLWithPath: "/home/u")

    func test_default_server_url_is_loopback_4280() {
        XCTAssertEqual(AppConfig.resolveServerURL([:]).absoluteString, "http://127.0.0.1:4280")
    }

    func test_bad_server_url_falls_back_to_default() {
        XCTAssertEqual(AppConfig.resolveServerURL(["SWITCHYARD_URL": "ftp://x"]).absoluteString, "http://127.0.0.1:4280")
        XCTAssertEqual(AppConfig.resolveServerURL(["SWITCHYARD_URL": "http://localhost:9"]).absoluteString, "http://localhost:9")
    }

    /// The token and the window list go to this machine only, whatever the environment says.
    func test_server_url_must_be_loopback() {
        let fallback = "http://127.0.0.1:4280"
        for remote in ["http://example.com:4280", "https://10.0.0.5:4280", "http://127.0.0.1.evil.test:4280",
                       "http://localhost.evil.test", "http://user@evil.test:4280", "http://192.168.1.20:4280"] {
            XCTAssertEqual(AppConfig.resolveServerURL(["SWITCHYARD_URL": remote]).absoluteString, fallback, remote)
        }
        for local in ["http://127.0.0.1:9", "http://localhost:4281", "http://[::1]:4280"] {
            XCTAssertEqual(AppConfig.resolveServerURL(["SWITCHYARD_URL": local]).absoluteString, local)
        }
    }

    func test_token_is_looked_up_in_priority_order() {
        let env = ["SWITCHYARD_DATA_DIR": "/data"]
        let all = { (p: String) in true }
        XCTAssertEqual(AppConfig.tokenFile(environment: env, home: home, fileExists: all)?.path, "/data/hook-token")
        let onlyOld = { (p: String) in p == "/home/u/.claude-mission-control/hook-token" }
        XCTAssertEqual(AppConfig.tokenFile(environment: [:], home: home, fileExists: onlyOld)?.path, "/home/u/.claude-mission-control/hook-token")
        let new = { (p: String) in p.hasPrefix("/home/u/.switchyard") || p.hasPrefix("/home/u/.claude-mission-control") }
        XCTAssertEqual(AppConfig.tokenFile(environment: [:], home: home, fileExists: new)?.path, "/home/u/.switchyard/hook-token")
        XCTAssertNil(AppConfig.tokenFile(environment: [:], home: home, fileExists: { _ in false }))
    }

    func test_path_segments_are_encoded() {
        XCTAssertEqual(APIClient.pathSegment("a/b c"), "a%2Fb%20c")
    }
}
