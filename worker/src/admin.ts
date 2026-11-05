import type { AppEnv } from "./env";
import { sendPush, type Fetch } from "./fcm";
import { BodyError, json, normalizeUuid, readJson } from "./http";
import type { Store } from "./store";

const MAX_BODY_BYTES = 32 * 1024;
const MAX_TEXT_LENGTH = 4000;
const MAX_STATUS_REFS = 100;

export async function isAuthorized(request: Request, env: AppEnv): Promise<boolean> {
  const expected = env.ADMIN_TOKEN;
  if (!expected) return false;
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  // Se comparan los digests para que la comparación no dependa de la longitud.
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(given)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

/**
 * `POST /v1/admin/replies`. Repetir la petición no duplica nada: si el aviso falló, lo reintenta;
 * si ya salió o la respuesta ya se entregó, no vuelve a avisar.
 */
export async function createReply(
  request: Request,
  env: AppEnv,
  store: Store,
  fetcher: Fetch,
  now: number,
): Promise<Response> {
  const body = (await readJson(request, MAX_BODY_BYTES)) ?? {};
  const { ref: rawRef, reply_id: rawReplyId, text } = body as { ref?: unknown; reply_id?: unknown; text?: unknown };

  const ref = normalizeUuid(rawRef);
  const replyId = normalizeUuid(rawReplyId);
  if (!ref || !replyId) throw new BodyError(400);
  if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT_LENGTH) throw new BodyError(400);

  const existing = await store.saveReply(replyId, ref, text, now);
  if (existing) {
    if (existing.ref !== ref || existing.text !== text) return json({ error: "reply_id_conflict" }, 409);
    if (existing.pushed_at !== null) return json({ status: "duplicate", push: "already_sent" });
    if (existing.delivered_at !== null) return json({ status: "duplicate", push: "already_delivered" });
  }
  const status = existing ? "duplicate" : "stored";

  const token = await store.token(ref);
  if (!token) return json({ status, push: "no_token" });

  const push = await sendPush(token, env, fetcher, now);
  if (push === "sent") await store.markPushed(replyId, now);
  if (push === "invalid_token") await store.deleteToken(ref);
  return json({ status, push });
}

/** `POST /v1/admin/replies/status`: respuestas guardadas de esos `ref`. No marca nada como entregado. */
export async function replyStatus(request: Request, store: Store): Promise<Response> {
  const { refs: rawRefs } = ((await readJson(request, MAX_BODY_BYTES)) ?? {}) as { refs?: unknown };
  if (!Array.isArray(rawRefs) || rawRefs.length > MAX_STATUS_REFS) throw new BodyError(400);
  const refs = rawRefs.map(normalizeUuid);
  if (refs.some((ref) => ref === null)) throw new BodyError(400);
  const unique = [...new Set(refs as string[])];
  return json({ replies: unique.length > 0 ? await store.replies(unique) : [] });
}
