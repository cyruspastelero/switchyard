import Foundation

enum ConfigError: Error, LocalizedError {
    case noTokenFile
    case emptyToken(String)
    case unreadable(String, String)

    var errorDescription: String? {
        switch self {
        case .noTokenFile: return "No hook-token file found (looked in SWITCHYARD_DATA_DIR, ~/.switchyard, ~/.claude-mission-control)"
        case .emptyToken(let p): return "hook-token file is empty: \(p)"
        case .unreadable(let p, let why): return "cannot read hook-token at \(p): \(why)"
        }
    }
}

struct AppConfig {
    static let defaultURL = URL(string: "http://127.0.0.1:4280")! // literal, always valid

    let serverURL: URL
    let environment: [String: String]
    let home: URL

    static func load(environment: [String: String] = ProcessInfo.processInfo.environment,
                     home: URL = FileManager.default.homeDirectoryForCurrentUser) -> AppConfig {
        AppConfig(serverURL: resolveServerURL(environment), environment: environment, home: home)
    }

    /// The server is always on this machine. A URL pointing anywhere else is ignored, so the bearer token,
    /// window titles and tab URLs can never be sent off the Mac by a stray environment variable.
    static let loopbackHosts: Set<String> = ["127.0.0.1", "localhost", "::1"]

    static func resolveServerURL(_ env: [String: String]) -> URL {
        let raw = env["SWITCHYARD_URL"] ?? env["MC_URL"]
        guard let raw, let url = URL(string: raw), let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https", let host = url.host?.lowercased(),
              loopbackHosts.contains(host), url.user == nil else { return defaultURL }
        return url
    }

    /// Data dir candidates in priority order.
    static func dataDirCandidates(environment: [String: String], home: URL) -> [URL] {
        var dirs: [URL] = []
        for name in ["SWITCHYARD_DATA_DIR", "MC_DATA_DIR"] {
            if let v = environment[name], !v.isEmpty { dirs.append(URL(fileURLWithPath: v)) }
        }
        dirs.append(home.appendingPathComponent(".switchyard"))
        dirs.append(home.appendingPathComponent(".claude-mission-control"))
        return dirs
    }

    static func tokenFile(environment: [String: String], home: URL,
                          fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }) -> URL? {
        dataDirCandidates(environment: environment, home: home)
            .map { $0.appendingPathComponent("hook-token") }
            .first { fileExists($0.path) }
    }

    /// Read on every request so a regenerated token is picked up without a restart.
    func readToken() throws -> String {
        guard let file = Self.tokenFile(environment: environment, home: home) else { throw ConfigError.noTokenFile }
        do {
            let text = try String(contentsOf: file, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { throw ConfigError.emptyToken(file.path) }
            return text
        } catch let e as ConfigError {
            throw e
        } catch {
            throw ConfigError.unreadable(file.path, error.localizedDescription)
        }
    }
}
