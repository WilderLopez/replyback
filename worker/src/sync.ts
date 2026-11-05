import type { AppEnv } from "./env";
import { BodyError, json, normalizeUuid, readJson } from "./http";
import type { Store } from "./store";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_REFS = 20;
const MAX_TOKEN_LENGTH = 4096;

/** `POST /v1/sync`. Sin `fcm_token` no se guarda nada: es la consulta de comentarios antiguos. */
export async function sync(request: Request, env: AppEnv, store: Store, now: number): Promise<Response> {
  if (env.RATE_LIMITER) {
    const key = request.headers.get("cf-connecting-ip") ?? "unknown";
    const { success } = await env.RATE_LIMITER.limit({ key });
    if (!success) return json({ error: "rate_limited" }, 429);
  }

  const body = await readJson(request, MAX_BODY_BYTES);
  const { refs: rawRefs, fcm_token: token } = (body ?? {}) as { refs?: unknown; fcm_token?: unknown };

  if (!Array.isArray(rawRefs) || rawRefs.length === 0 || rawRefs.length > MAX_REFS) {
    throw new BodyError(400);
  }
  const refs = rawRefs.map(normalizeUuid);
  if (refs.some((ref) => ref === null)) throw new BodyError(400);
  const unique = [...new Set(refs as string[])];

  if (token !== undefined && (typeof token !== "string" || !token || token.length > MAX_TOKEN_LENGTH)) {
    throw new BodyError(400);
  }

  if (typeof token === "string") await store.saveToken(unique, token, now);
  return json({ replies: await store.collect(unique, now) });
}
