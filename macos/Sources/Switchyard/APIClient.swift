import Foundation

enum APIError: Error, LocalizedError {
    case unreachable(operation: String)
    case http(operation: String, status: Int)
    case decoding(operation: String)
    case config(ConfigError, operation: String)

    var errorDescription: String? {
        switch self {
        case .unreachable(let op): return "\(op): server not reachable"
        case .http(let op, let status): return "\(op): server answered HTTP \(status)"
        case .decoding(let op): return "\(op): unexpected response shape"
        case .config(let e, let op): return "\(op): \(e.localizedDescription)"
        }
    }
}

/// Talks to the Switchyard server. Bearer token on every request; the token is never logged.
final class APIClient {
    let config: AppConfig
    private let session: URLSession

    init(config: AppConfig) {
        self.config = config
        let cfg = URLSessionConfiguration.ephemeral
        cfg.waitsForConnectivity = false
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: cfg)
    }

    // MARK: Endpoints

    func fetchContexts() async throws -> ContextsResponse {
        try decode(await request("GET", "/api/contexts", operation: "fetch contexts"), "fetch contexts")
    }

    func putSnapshot(_ body: SnapshotBody) async throws {
        _ = try await request("PUT", "/api/contexts/snapshot", body: encode(body), operation: "put snapshot")
    }

    /// With `since == nil` the server answers at once with no commands and its latest seq,
    /// so a freshly started app never replays old commands (closing or reopening windows).
    func fetchCommands(since: Int?) async throws -> (commands: [AppCommand], lastSeq: Int?) {
        let query = since.map { [URLQueryItem(name: "since", value: String($0))] } ?? []
        let data = try await request("GET", "/api/contexts/commands", query: query,
                                     timeout: 35, operation: "poll commands")
        if data.isEmpty { return ([], nil) }
        let envelope = try decode(data, "poll commands", as: CommandsEnvelope.self)
        return (envelope.commands, envelope.lastSeq)
    }

    func ack(seq: Int, ok: Bool, error: String?, failedKeys: [String] = []) async throws {
        _ = try await request("POST", "/api/contexts/commands/\(seq)/ack",
                              body: encode(AckBody(ok: ok, error: error, failedKeys: failedKeys)),
                              operation: "ack command \(seq)")
    }

    func switchContext(id: String) async throws {
        _ = try await request("POST", "/api/contexts/\(Self.pathSegment(id))/switch", operation: "switch context")
    }

    /// Tells the server no context is active any more, so it stops re-hiding windows.
    func showAll() async throws {
        _ = try await request("POST", "/api/contexts/show-all", operation: "show all windows")
    }

    /// The dashboard access code. The server gives it only to this app, over loopback. Never logged.
    func fetchAccessCode() async throws -> String {
        let r: AccessCodeResponse = try decode(await request("GET", "/api/contexts/access-code", operation: "fetch access code"),
                                               "fetch access code")
        return r.accessCode
    }

    func sortWindows() async throws {
        _ = try await request("POST", "/api/contexts/sort", operation: "sort windows")
    }

    /// One app's icon for the dashboard (PNG, at most 16 KB).
    func putIcon(bundleId: String, png: Data) async throws {
        _ = try await request("PUT", "/api/contexts/icons/\(Self.pathSegment(bundleId))", body: png,
                              contentType: "image/png", operation: "upload app icon")
    }

    // MARK: Plumbing

    static func pathSegment(_ s: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/")
        return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
    }

    private func encode<T: Encodable>(_ value: T) throws -> Data { try JSONEncoder().encode(value) }

    private func decode<T: Decodable>(_ data: Data, _ op: String, as type: T.Type = T.self) throws -> T {
        do { return try JSONDecoder().decode(T.self, from: data) } catch {
            Log.api.error("decode failed for \(op, privacy: .public): \(String(describing: error), privacy: .public)")
            throw APIError.decoding(operation: op)
        }
    }

    private func request(_ method: String, _ path: String, query: [URLQueryItem] = [], body: Data? = nil,
                         contentType: String = "application/json",
                         timeout: TimeInterval = 10, operation: String) async throws -> Data {
        let token: String
        do { token = try config.readToken() } catch let e as ConfigError { throw APIError.config(e, operation: operation) }

        guard var comps = URLComponents(url: config.serverURL, resolvingAgainstBaseURL: false) else {
            throw APIError.unreachable(operation: operation)
        }
        comps.path = path
        comps.queryItems = query.isEmpty ? nil : query
        guard let url = comps.url else { throw APIError.unreachable(operation: operation) }

        var req = URLRequest(url: url, timeoutInterval: timeout)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            req.httpBody = body
            req.setValue(contentType, forHTTPHeaderField: "Content-Type")
        }
        do {
            let (data, response) = try await session.data(for: req)
            guard let http = response as? HTTPURLResponse else { throw APIError.unreachable(operation: operation) }
            guard (200..<300).contains(http.statusCode) else { throw APIError.http(operation: operation, status: http.statusCode) }
            return data
        } catch let e as APIError {
            throw e
        } catch is CancellationError {
            throw CancellationError()
        } catch let e as URLError where e.code == .cancelled {
            throw CancellationError()
        } catch {
            throw APIError.unreachable(operation: operation)
        }
    }
}
