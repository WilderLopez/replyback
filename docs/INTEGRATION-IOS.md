# Integrate the iOS SDK

The `Replyback` package has no dependencies, not even on Sentry, and no UI: your app sends the message through its
own channel and draws the threads however it wants. It requires iOS 17 and Swift 6 tools.

Deploy the Worker first: see [DEPLOY.md](DEPLOY.md).

## 1. Add the package

In Xcode, add `https://github.com/WilderLopez/replyback.git`, or in `Package.swift`:

```swift
.package(url: "https://github.com/WilderLopez/replyback.git", .upToNextMinor(from: "0.3.0"))
```

## 2. Create one client

```swift
import Replyback

@MainActor
enum Support {
    static let client = ReplybackClient(
        configuration: ReplybackConfiguration(workerURL: workerURL)
    )
}
```

## 3. Connect it to your app

| When | Call |
|---|---|
| The user signs in, or the profile loads | `setAccount(userID:)` |
| The user signs out | `setAccount(userID: nil)`. Data is hidden, not deleted |
| The user sends a comment | `prepareComment(_:)`, then `sync(fcmToken:)` |
| The app opens or returns to the foreground | `syncIfNeeded(fcmToken:)`, then optionally `checkLegacyReplies()` |
| A push arrives, or the support screen opens | `sync(fcmToken:)` |
| A reply is shown | `markRead(replyID:)` |
| The user deletes their account | `deleteAllData()` |

### Sending a comment

`prepareComment` adds a key as the last line of the message. Send that message to Sentry unchanged.

```swift
let message = Support.client.prepareComment(text)
SentrySDK.capture(feedback: SentryFeedback(message: message, name: name, email: email, source: .custom))
await Support.client.sync(fcmToken: token)
```

Without an active account, the message has no key and the reply cannot be linked to this device.

### Handling the push

```swift
func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification
) async -> UNNotificationPresentationOptions {
    if ReplybackClient.isReplyNotification(notification.request.content.userInfo) {
        await Support.client.sync(fcmToken: token)
    }
    return [.banner, .sound]
}
```

When the user taps it, check `isReplyNotification` in `didReceive` and navigate to your support screen.

### Deleting an account

`deleteAllData()` works on the active account. If your flow signs the user out at the same time, use a separate
client so that signing out does not get in the way:

```swift
let deletion = ReplybackClient(configuration: configuration)
deletion.setAccount(userID: userID)
await deletion.deleteAllData()
```

If it fails, the keys are kept so you can retry. You can also delete the data with `replyback forget <issue>`.

## 4. Draw the threads

`threads` and `unreadCount` are observable from SwiftUI. Threads are sorted by most recent activity, and replies go
from oldest to newest.

```swift
ForEach(Support.client.threads) { thread in
    if let comment = thread.comment {
        Text(comment)
    }
    if thread.isAwaitingReply {
        Text("Awaiting reply")
    }
    ForEach(thread.replies) { reply in
        Text(reply.text)
            .onAppear { Support.client.markRead(replyID: reply.id) }
    }
}
```

## 5. Translate the push (optional)

The Worker does not know the user's language. To translate the push on the device, add two keys to your app's strings
and set them in `deployments/<name>/wrangler.jsonc`:

```jsonc
"PUSH_TITLE_LOC_KEY": "replyback_push_title",
"PUSH_BODY_LOC_KEY": "replyback_push_body"
```

The keys must already be in the app version that registers tokens.

## Old comments

`checkLegacyReplies()` finds replies to comments sent before integrating the SDK. It works by deriving the key from
the user ID and the `device_app_hash` that sentry-cocoa adds to each event, so it only applies to apps that
already used sentry-cocoa on iOS.

- It checks once per account and app build, so load your replies **before** releasing that build.
- It only works on the same iPhone and account that sent the comment.
- There is no push, because there is no token. The user sees the reply when opening the app.

## Before you ship

- **Privacy policy:** comments, replies, user IDs and push tokens are stored in your Cloudflare account with no expiry.
- **App Store privacy details:** declare the data you now collect.
- **Account deletion:** call `deleteAllData()` from your deletion flow.
- **Test with TestFlight:** Apple warns that `identifierForVendor` can change between Xcode and ad hoc installs, so
  old comments can only be tested reliably on a TestFlight or App Store build.
