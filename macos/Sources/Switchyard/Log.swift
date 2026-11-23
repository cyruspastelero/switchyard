import os

/// Loggers for each area. Never log the bearer token or window contents.
enum Log {
    static let subsystem = "ph.pastelero.switchyard"
    static let app = Logger(subsystem: subsystem, category: "app")
    static let api = Logger(subsystem: subsystem, category: "api")
    static let windows = Logger(subsystem: subsystem, category: "windows")
    static let browser = Logger(subsystem: subsystem, category: "browser")
    /// One line per switch with its timings. Read with: log show --predicate 'subsystem == "ph.pastelero.switchyard" && category == "switch"'
    static let timing = Logger(subsystem: subsystem, category: "switch")
    static let signposts = OSSignposter(subsystem: subsystem, category: "switch")
}
