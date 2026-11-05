# replyback

[![CI](https://github.com/WilderLopez/replyback/actions/workflows/ci.yml/badge.svg)](https://github.com/WilderLopez/replyback/actions/workflows/ci.yml)

Reply inside your app to the feedback your users send through Sentry.

Sentry collects user feedback but gives you no way to answer it. replyback adds that channel without
touching your app's backend and without email: you reply from a CLI, a Cloudflare Worker stores the reply
and sends a push, and your app shows the comment and its reply as a thread.

[Leer en español](README.es.md)

```text
App ── comment + ref ───► Sentry
 │                          ▲
 │                          │ reads comments (read-only)
 │                         CLI
 │                          │ sends the reply and the original comment
 │                          ▼
 └──── POST /v1/sync ───► Worker + D1 ──► FCM ──► push to the app
```

> [!NOTE]
> Early stage: the iOS SDK has been tested on a real iPhone but has not shipped in an App Store release yet.
> Android has no SDK, only a [documented API](docs/API.md).

## What you get

- **Threads in your app:** each comment with its replies, plus an "awaiting reply" state.
- **Free to start:** it should fit Cloudflare's and Firebase's free plans.
- **One deployment per project:** your own Worker, database and secrets. No central server.
- **No backend changes:** the Worker never calls your backend.
- **Works for old comments:** comments sent before integrating the SDK can also be answered, on iOS.

## How it handles data

| Data | Where it lives |
|---|---|
| Comment, reply, user ID, push token | Your Cloudflare account, with no expiry |
| Keys to read them (`ref`) | iCloud Keychain on the device, per account |
| Local copy of threads | App cache, excluded from backups |
| Email | Never stored by replyback |

- **Keys, not logins:** each comment carries a random UUID, and only its holder can read the replies. The
  user ID is not used as a key because it is not secret. It is sent by the CLI and never returned to the app.
- **Neutral push:** neither the reply nor the key travels in the notification.
- **Read-only on Sentry:** the CLI never writes there, and never prints emails or user IDs.
- **Deletion:** the app can erase its data with `deleteAllData()`, and you can with `replyback forget`.

> [!IMPORTANT]
> You become responsible for this data. Review your privacy policy before shipping, and call
> `deleteAllData()` from your account deletion flow.

## Get started

1. [Deploy the Worker and set up the CLI](docs/DEPLOY.md).
2. [Integrate the iOS SDK](docs/INTEGRATION-IOS.md), or implement the [API](docs/API.md) on another platform.
3. Answer your users:

```sh
pnpm replyback --deployment my-app list --pending
pnpm replyback --deployment my-app show PROJECT-123
pnpm replyback --deployment my-app reply PROJECT-123 "Fixed in the latest version, thanks for reporting it."
```

`reply` asks for confirmation before sending, and running the same command twice does not duplicate
the reply or the push.

## Known limits

- **Sentry's spam detector:** it can archive real comments on its own, and it sends no alerts for them. Use
  `replyback list`, which shows them as `[archived]`, rather than relying on alerts.
- **Sentry takes a few minutes** to make a new comment available.
- **The keys depend on iCloud Keychain:** without it, or when moving to another Apple ID or to Android, the
  user loses access to their history.
- **Unanswered comments are local:** the CLI uploads the comment when replying, so a comment with no reply
  does not appear on another device.
- **History window:** the CLI reads the last 90 days of comments.

## Development

```sh
make install
make check   # typecheck, Worker, CLI and SDK tests, and an iOS build
```

The design decisions are in [docs/diseno.md](docs/diseno.md), in Spanish.

## License

[MIT](LICENSE)
