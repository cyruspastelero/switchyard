import Foundation

enum OSAError: Error, LocalizedError {
    case launchFailed(String)
    case timedOut
    case failed(String)

    var errorDescription: String? {
        switch self {
        case .launchFailed(let m): return "could not start osascript: \(m)"
        case .timedOut: return "osascript timed out"
        case .failed(let m): return "script failed: \(m)"
        }
    }
}

enum OSALanguage: String {
    case javaScript = "JavaScript"
    case appleScript = "AppleScript"
}

/// Runs a JXA or AppleScript script with `/usr/bin/osascript`. Values go in `args` (argv), never into the script text.
enum OSAScript {
    static func run(_ script: String, args: [String], timeout: TimeInterval = 12,
                    language: OSALanguage = .javaScript) async throws -> String {
        try await withCheckedThrowingContinuation { cont in
            DispatchQueue.global(qos: .utility).async {
                cont.resume(with: Result { try runBlocking(script, args: args, timeout: timeout, language: language) })
            }
        }
    }

    /// Full output, not just the last line (multi-line results such as Arc's listing).
    static func runFull(_ script: String, args: [String], timeout: TimeInterval, language: OSALanguage) async throws -> String {
        try await withCheckedThrowingContinuation { cont in
            DispatchQueue.global(qos: .utility).async {
                cont.resume(with: Result { try runBlocking(script, args: args, timeout: timeout, language: language, full: true) })
            }
        }
    }

    private static func runBlocking(_ script: String, args: [String], timeout: TimeInterval,
                                    language: OSALanguage, full: Bool = false) throws -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        p.arguments = ["-l", language.rawValue, "-e", script] + args
        let pipe = Pipe() // stdout and stderr share it: osascript prints JXA results and errors to either
        p.standardOutput = pipe
        p.standardError = pipe
        p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { throw OSAError.launchFailed(error.localizedDescription) }

        let timedOut = Flag()
        let killer = DispatchWorkItem { if p.isRunning { timedOut.set(); p.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: killer)
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        killer.cancel()

        if timedOut.value { throw OSAError.timedOut }
        let text = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        guard p.terminationStatus == 0 else { throw OSAError.failed(String(text.prefix(300))) }
        return full ? text : lastLine(text)
    }

    /// The result is the last line; earlier lines can be warnings.
    static func lastLine(_ text: String) -> String {
        text.split(whereSeparator: \.isNewline).last.map(String.init) ?? ""
    }

    private final class Flag: @unchecked Sendable {
        private let lock = NSLock()
        private var flag = false
        func set() { lock.lock(); flag = true; lock.unlock() }
        var value: Bool { lock.lock(); defer { lock.unlock() }; return flag }
    }
}
