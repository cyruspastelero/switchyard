import Foundation
import UserNotifications

/// One notification when a context starts waiting. Clicking it switches to that context.
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    var onOpen: (@MainActor (String) -> Void)?

    /// UNUserNotificationCenter crashes when the process is not an app bundle (for example `swift run`).
    private var available: Bool { Bundle.main.bundleURL.pathExtension == "app" && Bundle.main.bundleIdentifier != nil }

    func start() {
        guard available else { Log.app.notice("notifications disabled: not running from an app bundle"); return }
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { granted, error in
            if let error { Log.app.error("notification authorization failed: \(error.localizedDescription, privacy: .public)") }
            else if !granted { Log.app.notice("notifications not allowed by the user") }
        }
    }

    func notifyWaiting(contextId: String, name: String) {
        guard available else { return }
        let content = UNMutableNotificationContent()
        content.title = name
        content.body = "Waiting on you"
        content.sound = .default
        content.userInfo = ["contextId": contextId]
        let req = UNNotificationRequest(identifier: "waiting-\(contextId)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req) { error in
            if let error { Log.app.error("could not post notification: \(error.localizedDescription, privacy: .public)") }
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let id = response.notification.request.content.userInfo["contextId"] as? String else { return }
        let handler = onOpen
        await MainActor.run { handler?(id) }
    }
}
