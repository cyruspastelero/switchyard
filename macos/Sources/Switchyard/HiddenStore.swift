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
            // The records hold window titles: owner-only.
            try PrivateFile.write(try JSONEncoder().encode(records), to: url)
        } catch {
            Log.windows.error("cannot save hidden-windows.json: \(error.localizedDescription, privacy: .public)")
        }
    }
}

/// Writes a file only its owner can read, atomically. `Data.write(options: .atomic)` makes its temporary file 0644
/// and a chmod afterwards leaves a moment where others can read it, so the temporary file is created 0600 here and
/// renamed over the target. A folder made here is 0700; an existing folder is left as it is.
enum PrivateFile {
    static func write(_ data: Data, to url: URL) throws {
        let folder = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let temp = folder.appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).tmp")
        let fd = open(temp.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
        guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        do {
            let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
            try handle.write(contentsOf: data)
            try handle.close()
            guard rename(temp.path, url.path) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        } catch {
            try? FileManager.default.removeItem(at: temp)
            throw error
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
