import Foundation

/// A window moved off-screen by Switchyard. Persisted so a crash can be recovered at next launch.
struct HiddenRecord: Codable, Equatable {
    let key: String
    let pid: Int32
    let bundleId: String
    let title: String
    let frame: Rect
}

struct HiddenStore {
    let url: URL

    static var defaultURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("Switchyard/hidden-windows.json")
    }

    init(url: URL = HiddenStore.defaultURL) { self.url = url }

    func load() -> [HiddenRecord] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        do { return try JSONDecoder().decode([HiddenRecord].self, from: data) } catch {
            Log.windows.error("hidden-windows.json is unreadable: \(error.localizedDescription, privacy: .public)")
            return []
        }
    }

    func save(_ records: [HiddenRecord]) {
        do {
            if records.isEmpty { try? FileManager.default.removeItem(at: url); return }
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(records).write(to: url, options: .atomic)
            // The records hold window titles: owner-only.
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        } catch {
            Log.windows.error("cannot save hidden-windows.json: \(error.localizedDescription, privacy: .public)")
        }
    }
}

enum HiddenRecords {
    /// A hidden window that is not listed right now may sit on another macOS desktop, or its app may be busy.
    /// Forget it only when its app has quit; otherwise it could never be brought back.
    static func surviving<K: Hashable>(_ hidden: [K: HiddenRecord], listed: Set<K>, runningPids: Set<Int32>) -> [K: HiddenRecord] {
        hidden.filter { listed.contains($0.key) || runningPids.contains($0.value.pid) }
    }
}
