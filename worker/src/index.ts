import { createReply, isAuthorized, replyStatus } from "./admin";
import type { AppEnv } from "./env";
import type { Fetch } from "./fcm";
import { BodyError, json } from "./http";
import { Store } from "./store";
import { sync } from "./sync";

const DAY_MS = 24 * 3600 * 1000;
const DELIVERED_RETENTION_MS = 30 * DAY_MS;
const UNDELIVERED_RETENTION_MS = 180 * DAY_MS;
const TOKEN_RETENTION_MS = 180 * DAY_MS;

// `fetch` necesita su `this` original, así que no se pasa suelto.
const globalFetch: Fetch = (input, init) => fetch(input, init);

export async function handle(request: Request, env: AppEnv, fetcher: Fetch = globalFetch): Promise<Response> {
  const route = `${request.method} ${new URL(request.url).pathname}`;
  const store = new Store(env.DB);
  const now = Date.now();

  try {
    if (route === "POST /v1/sync") return await sync(request, env, store, now);

    if (route === "POST /v1/admin/replies") {
      if (!(await isAuthorized(request, env))) return json({ error: "unauthorized" }, 401);
      return await createReply(request, env, store, fetcher, now);
    }

    if (route === "POST /v1/admin/replies/status") {
      if (!(await isAuthorized(request, env))) return json({ error: "unauthorized" }, 401);
      return await replyStatus(request, store);
    }
  } catch (error) {
    if (error instanceof BodyError) {
      return json({ error: error.status === 413 ? "too_large" : "bad_request" }, error.status);
    }
    console.error(JSON.stringify({ event: "unhandled", name: error instanceof Error ? error.name : "unknown" }));
    return json({ error: "internal" }, 500);
  }

  return json({ error: "not_found" }, 404);
}

export async function cleanup(env: AppEnv, now: number): Promise<void> {
  await new Store(env.DB).cleanup({
    delivered: now - DELIVERED_RETENTION_MS,
    undelivered: now - UNDELIVERED_RETENTION_MS,
    tokens: now - TOKEN_RETENTION_MS,
  });
}

export default {
  fetch: (request, env) => handle(request, env),
  scheduled: (_controller, env) => cleanup(env, Date.now()),
} satisfies ExportedHandler<AppEnv>;
