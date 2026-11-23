// Arc's JavaScript (JXA) bridge fails with "Can't convert types" on window and tab properties,
// but plain AppleScript works, so Arc is read through AppleScript. Verified 2026-11-22.
// Arc's AppleScript `close window` does nothing and `make new window` returns no value, so Arc is
// read-only here: sorting and switching work (they use Accessibility), naming/park/tab moves do not.
enum ArcScripts {
    /// Arc is named in the text, not passed in: with `tell application id (variable)` the script compiles
    /// without Arc's dictionary and Arc answers "Can't get every window" (-1728). Output: one record per line, fields split by ASCII 31 (unit separator),
    /// records split by ASCII 30 (record separator). "W" window: id, name. "T" tab: id, url, title.
    static let list = """
    on run
      set us to ASCII character 31
      set rs to ASCII character 30
      set out to ""
      tell application id "company.thebrowser.Browser"
        repeat with w in windows
          set out to out & "W" & us & (id of w) & us & (name of w) & rs
          repeat with t in tabs of w
            set out to out & "T" & us & (id of t) & us & (URL of t) & us & (title of t) & rs
          end repeat
        end repeat
      end tell
      return out
    end run
    """

    struct ParsedWindow: Equatable {
        let id: String
        let name: String?
        let tabs: [BrowserTab]
    }

    /// Pure parser for `list` output (tested).
    static func parse(_ text: String) -> [ParsedWindow] {
        var windows: [ParsedWindow] = []
        var current: (id: String, name: String?, tabs: [BrowserTab])?
        for record in text.split(separator: "\u{1E}", omittingEmptySubsequences: true) {
            let f = record.split(separator: "\u{1F}", omittingEmptySubsequences: false).map(String.init)
            if f.first == "W", f.count >= 2 {
                if let c = current { windows.append(ParsedWindow(id: c.id, name: c.name, tabs: c.tabs)) }
                let name = f.count > 2 ? f[2].trimmingCharacters(in: .whitespacesAndNewlines) : ""
                current = (f[1].trimmingCharacters(in: .whitespacesAndNewlines), name.isEmpty ? nil : name, [])
            } else if f.first == "T", f.count >= 4, current != nil {
                current?.tabs.append(BrowserTab(id: f[1], url: f[2], title: f[3]))
            }
        }
        if let c = current { windows.append(ParsedWindow(id: c.id, name: c.name, tabs: c.tabs)) }
        return windows
    }
}
