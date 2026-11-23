import Foundation

struct ShowSets: Equatable {
    let shown: Set<String>
    let hide: Set<String>
}

/// What a `show` command does to each window. Pure, so it is tested.
enum ShowPlan {
    /// The server lists the windows to hide. Without that list nothing is hidden: guessing here once hid every window.
    static func sets(for cmd: AppCommand) throws -> ShowSets {
        guard let hide = cmd.hideKeys else { throw CommandError.missing("hideKeys") }
        return ShowSets(shown: Set(cmd.windowKeys), hide: Set(hide))
    }

    /// Only listed windows are hidden, and never one that is also to be shown. Everything else is brought back.
    static func hides(_ key: String, _ sets: ShowSets) -> Bool {
        sets.hide.contains(key) && !sets.shown.contains(key)
    }

    /// The order of work: target windows come back first (then they are raised), other windows are hidden
    /// behind them, and windows that merely stopped being hidden come back last. `keys` is every known window.
    static func phases(keys: [String], hidden: Set<String>, sets: ShowSets) -> (restoreFirst: [String], hide: [String], restoreLast: [String]) {
        var restoreFirst: [String] = [], hide: [String] = [], restoreLast: [String] = []
        for key in keys {
            let isHidden = hidden.contains(key)
            if hides(key, sets) {
                if !isHidden { hide.append(key) }
            } else if isHidden {
                if sets.shown.contains(key) { restoreFirst.append(key) } else { restoreLast.append(key) }
            }
        }
        return (restoreFirst, hide, restoreLast)
    }
}
