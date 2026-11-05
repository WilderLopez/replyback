# Worker API

Use this to integrate another platform or a backoffice. All requests are `POST` with a JSON body, and all timestamps
are Unix milliseconds. Errors have the form `{ "error": "<code>" }`.

## How the key works

The app creates a random UUID (`ref`) per comment and appends it as the **last line** of the message it sends to Sentry:

```text
Text written by the user

ref:3f2b8c1e-6a4d-4e7f-9b10-2c5d8e7a1f34
```

Only the last line counts, so a user cannot inject another key in the text. Whoever holds a `ref` can read and delete its
data, so it must not leave the device other than in the comment and in requests to the Worker.

## App endpoints

These need no authentication and are rate limited per IP.

### `POST /v1/sync`

Registers the push token for those `ref` values and returns their replies. Without `fcm_token`, it stores nothing.

```json
{ "refs": ["<uuid>"], "fcm_token": "<optional>" }
```

```json
{
  "replies": [
    {
      "reply_id": "<uuid>",
      "ref": "<uuid>",
      "text": "...",
      "comment": "...",
      "comment_at": 0,
      "created_at": 0,
      "delivered_at": null
    }
  ]
}
```

- Accepts up to 20 `refs`, and returns replies already delivered, so remove duplicates by `reply_id`.
- `delivered_at` is the value before this request. If it has a date, another installation collected the reply earlier.
- The push carries `{ "type": "replyback.reply" }` as data: call this endpoint when it arrives.

### `POST /v1/delete`

```json
{ "refs": ["<uuid>"] }
```

Deletes the replies and tokens of those `ref` values. Accepts up to 20.

## Admin endpoints

These require `Authorization: Bearer <ADMIN_TOKEN>`.

### `POST /v1/admin/replies`

```json
{
  "ref": "<uuid>",
  "reply_id": "<uuid>",
  "text": "...",
  "comment": "...",
  "comment_at": 0,
  "user_id": "<optional>"
}
```

```json
{ "status": "stored", "push": "sent" }
```

| Field | Values |
|---|---|
| `status` | `stored`, `duplicate` |
| `push` | `sent`, `no_token`, `failed`, `invalid_token`, `not_configured`, `already_sent`, `already_delivered` |

- The caller generates `reply_id`. Repeating a request does not duplicate anything, and retries the push if it failed.
- The same `reply_id` with different content returns `409 reply_id_conflict`.
- `text` allows 4000 characters, `comment` 8000 and `user_id` 255.

### `POST /v1/admin/replies/status`

```json
{ "refs": ["<uuid>"] }
```

Returns the stored replies of up to 100 `refs`, including `user_id`, without marking them as delivered.

### `POST /v1/admin/delete`

```json
{ "user_id": "<id>" }
```

Deletes everything about an account, even if its keys were lost. Returns `{ "status": "deleted", "replies": 0 }`.

## Error codes

| Status | `error` | Meaning |
|---|---|---|
| 400 | `bad_request` | Invalid body or field |
| 401 | `unauthorized` | Missing or wrong admin token |
| 404 | `not_found` | Unknown route |
| 409 | `reply_id_conflict` | `reply_id` already used with other content |
| 413 | `too_large` | Body too large |
| 429 | `rate_limited` | Too many requests from that IP |
| 500 | `internal` | Unexpected error |

## Retention

History never expires: it is only deleted through the endpoints above. A daily cron deletes tokens inactive for
180 days that have no pending replies.
