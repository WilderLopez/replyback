# Deploy replyback

Each project gets its own Worker, D1 database and secrets. Everything specific to your project lives in
`deployments/<name>/`, which stays out of git.

## What you need

- A Cloudflare account. The free plan's daily quota is per account, so it is shared with your other Workers.
- A Firebase project with Cloud Messaging set up for your app, including its APNs key.
- A Sentry project that receives your users' feedback.
- Node 22.18 or later, and pnpm.

## 1. Create the deployment

```sh
git clone https://github.com/WilderLopez/replyback.git
cd replyback
make install
cp -R deployments/example deployments/my-app
cd worker
pnpm exec wrangler login
pnpm exec wrangler d1 create replyback-my-app
cd ..
```

Edit `deployments/my-app/wrangler.jsonc`:

| Field | Value |
|---|---|
| `name` | `replyback-my-app` |
| `database_name`, `database_id` | The name you chose and the ID that `d1 create` printed |
| `namespace_id` | A number no other Worker in the account uses |
| `PUSH_TITLE`, `PUSH_BODY` | Neutral text. The reply never travels in the push |

## 2. Deploy

```sh
make deploy D=my-app
```

This applies the pending migrations, checks that none is left, and only then deploys. Always deploy this way:
new code on an old database fails. Note the URL it prints.

## 3. Add the secrets

```sh
cd worker
openssl rand -hex 32   # your admin token: keep it for step 4
pnpm exec wrangler secret put ADMIN_TOKEN --config ../deployments/my-app/wrangler.jsonc
pnpm exec wrangler secret put FCM_SERVICE_ACCOUNT --config ../deployments/my-app/wrangler.jsonc < path/to/key.json
cd ..
```

`FCM_SERVICE_ACCOUNT` is the JSON key of a Google service account. Create one just for this, because the default
Firebase key has far more permissions than it needs:

1. In the Google Cloud console, open **IAM & Admin > Service Accounts** for your Firebase project.
2. Create a service account with the **Firebase Cloud Messaging API Admin** role.
3. Open it and choose **Keys > Add key > Create new key > JSON**.

Never commit this file. `deployments/<name>/` is ignored by git, so it is a safe place to keep it.

## 4. Set up the CLI

```sh
cp deployments/example/.env.example deployments/my-app/.env
```

| Variable | Value |
|---|---|
| `SENTRY_AUTH_TOKEN` | A Sentry token with only the `event:read` scope |
| `SENTRY_ORG`, `SENTRY_PROJECT` | Your organization and project slugs |
| `REPLYBACK_URL` | The Worker URL from step 2 |
| `REPLYBACK_ADMIN_TOKEN` | The token from step 3 |

Check that it works:

```sh
pnpm replyback --deployment my-app list
```

## 5. Integrate your app

Continue with [INTEGRATION-IOS.md](INTEGRATION-IOS.md), or implement the [API](API.md) on another platform.

## Use your own domain

The `workers.dev` URL includes your account's subdomain and ends up in your app binary. If your domain is on the
same Cloudflare account, set a stable URL before shipping, so you can move accounts without releasing a new app:

```jsonc
"routes": [{ "pattern": "support.example.com", "custom_domain": true }]
```

Run `make deploy D=my-app` again and use that URL in the app and in `REPLYBACK_URL`.

## Move to another Cloudflare account

1. Run `wrangler logout`, then `wrangler login` with the new account.
2. Create the database, update `database_id`, and run `make deploy D=my-app`. This creates the empty tables.
3. Add the secrets again, with a new `ADMIN_TOKEN`. The Firebase key can stay the same.
4. If there is data to keep, export it from the old account **before** logging out, and import it into the new one:

```sh
pnpm exec wrangler d1 export DB --remote --config ../deployments/my-app/wrangler.jsonc \
  --no-schema --table replies --table tokens --output data.sql
pnpm exec wrangler d1 execute DB --remote --config ../deployments/my-app/wrangler.jsonc --file data.sql
```

5. Point the app and the CLI at the new URL. Apps already released keep calling the old URL, so keep the old
   Worker running until they update, unless you use your own domain.

`data.sql` contains personal data: delete it when you finish.

## Troubleshooting

| Symptom | Cause |
|---|---|
| The CLI does not list a comment you just sent | Sentry takes a few minutes |
| A comment shows `[archived]` | Sentry's spam detector archived it. It can still be answered |
| `the push failed` | Run the same command again: it retries without duplicating anything |
| `no push because there is no token` | The app has not synced yet, or the user denied notifications. The reply is delivered when the app checks |
| `no push because the token is no longer valid` | The user signed out or uninstalled the app. The reply is delivered when they return |
| `no push because the Worker has no FCM configuration` | `FCM_SERVICE_ACCOUNT` is missing or invalid |
| `The Worker responded 401` | `REPLYBACK_ADMIN_TOKEN` does not match `ADMIN_TOKEN` |
| `Sentry responded 403` | The Sentry token lacks `event:read` or access to the project |
