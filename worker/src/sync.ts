import type { AppEnv } from "./env";
import { BodyError, json, normalizeUuid, readJson } from "./http";
import type { Store } from "./store";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_REFS = 20;
const MAX_TOKEN_LENGTH = 4096;

async function isRateLimited(request: Request, env: AppEnv): Promise<boolean> {
  if (!env.RATE_LIMITER) return false;
  const key = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await env.RATE_LIMITER.limit({ key });
  return !success;
}

function parseRefs(body: { refs?: unknown }): string[] {
  const { refs } = body;
  if (!Array.isArray(refs) || refs.length === 0 || refs.length > MAX_REFS) throw new BodyError(400);
  const parsed = refs.map(normalizeUuid);
  if (parsed.some((ref) => ref === null)) throw new BodyError(400);
  return [...new Set(parsed as string[])];
}

/** `POST /v1/sync`. Sin `fcm_token` no se guarda nada: es la consulta de comentarios antiguos. */
export async function sync(request: Request, env: AppEnv, store: Store, now: number): Promise<Response> {
  if (await isRateLimited(request, env)) return json({ error: "rate_limited" }, 429);

  const body = ((await readJson(request, MAX_BODY_BYTES)) ?? {}) as { refs?: unknown; fcm_token?: unknown };
  const refs = parseRefs(body);
  const { fcm_token: token } = body;
  if (token !== undefined && (typeof token !== "string" || !token || token.length > MAX_TOKEN_LENGTH)) {
    throw new BodyError(400);
  }

  if (typeof token === "string") await store.saveToken(refs, token, now);
  return json({ replies: await store.collect(refs, now) });
}

/** `POST /v1/delete`. Quien tiene el `ref` puede leer sus datos, y también borrarlos. */
export async function deleteData(request: Request, env: AppEnv, store: Store): Promise<Response> {
  if (await isRateLimited(request, env)) return json({ error: "rate_limited" }, 429);

  const body = ((await readJson(request, MAX_BODY_BYTES)) ?? {}) as { refs?: unknown };
  await store.deleteRefs(parseRefs(body));
  return json({ status: "deleted" });
}
