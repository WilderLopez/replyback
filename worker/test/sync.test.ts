import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handle } from "../src/index";
import { failingFetch, fakeFetch, post, replyRequest, syncRequest, uuid } from "./helpers";

const tokenFor = (ref: string) =>
  env.DB.prepare("SELECT fcm_token FROM tokens WHERE ref = ?").bind(ref).first<string>("fcm_token");

describe("POST /v1/sync", () => {
  it.each([
    ["sin refs", {}],
    ["refs vacío", { refs: [] }],
    ["refs que no es lista", { refs: "x" }],
    ["ref que no es UUID", { refs: ["no-es-uuid"] }],
    ["ref que no es texto", { refs: [1] }],
    ["demasiados refs", { refs: Array.from({ length: 21 }, uuid) }],
    ["token vacío", { refs: [uuid()], fcm_token: "" }],
    ["token que no es texto", { refs: [uuid()], fcm_token: 1 }],
    ["token demasiado largo", { refs: [uuid()], fcm_token: "x".repeat(4097) }],
    ["JSON que es null", null],
  ])("rechaza %s", async (_name, body) => {
    const response = await handle(post("/v1/sync", body), env, failingFetch);
    expect(response.status).toBe(400);
  });

  it("rechaza un cuerpo que no es JSON", async () => {
    const response = await handle(post("/v1/sync", "{no json"), env, failingFetch);
    expect(response.status).toBe(400);
  });

  it("rechaza un cuerpo demasiado grande", async () => {
    const response = await handle(post("/v1/sync", "x".repeat(17 * 1024)), env, failingFetch);
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "too_large" });
  });

  it("rechaza un cuerpo grande que no declara su tamaño", async () => {
    const stream = new Blob(["x".repeat(17 * 1024)]).stream();
    const request = new Request("https://replyback.test/v1/sync", { method: "POST", body: stream });
    request.headers.delete("content-length");
    const response = await handle(request, env, failingFetch);
    expect(response.status).toBe(413);
  });

  it("sin token no guarda nada", async () => {
    const ref = uuid();
    const response = await handle(syncRequest([ref]), env, failingFetch);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ replies: [] });
    await expect(tokenFor(ref)).resolves.toBeNull();
  });

  it("guarda el token de cada ref y lo actualiza si cambia", async () => {
    const [a, b] = [uuid(), uuid()];
    await handle(syncRequest([a, b], "token-1"), env, failingFetch);
    await expect(tokenFor(a)).resolves.toBe("token-1");
    await expect(tokenFor(b)).resolves.toBe("token-1");

    await handle(syncRequest([a], "token-2"), env, failingFetch);
    await expect(tokenFor(a)).resolves.toBe("token-2");
    await expect(tokenFor(b)).resolves.toBe("token-1");
  });

  it("normaliza los UUID en mayúsculas y elimina repetidos", async () => {
    const ref = uuid();
    const response = await handle(syncRequest([ref.toUpperCase(), ref], "token"), env, failingFetch);
    expect(response.status).toBe(200);
    await expect(tokenFor(ref)).resolves.toBe("token");
  });

  it("devuelve solo las respuestas de sus refs y marca la entrega", async () => {
    const [mine, other, replyId] = [uuid(), uuid(), uuid()];
    const { fetcher } = fakeFetch();
    await handle(replyRequest(mine, replyId, "Para mí"), env, fetcher);
    await handle(replyRequest(other, uuid(), "Para otro"), env, fetcher);

    const response = await handle(syncRequest([mine]), env, failingFetch);
    const { replies } = await response.json<{ replies: Array<Record<string, unknown>> }>();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      reply_id: replyId,
      ref: mine,
      text: "Para mí",
      comment: "Comentario inventado",
      comment_at: 1_700_000_000_000,
      delivered_at: null,
    });
    expect(replies[0]).not.toHaveProperty("pushed_at");

    const stored = await env.DB.prepare("SELECT delivered_at FROM replies WHERE reply_id = ?")
      .bind(replyId)
      .first<number>("delivered_at");
    expect(stored).toBeGreaterThan(0);

    const untouched = await env.DB.prepare("SELECT delivered_at FROM replies WHERE ref = ?")
      .bind(other)
      .first("delivered_at");
    expect(untouched).toBeNull();
  });

  it("vuelve a entregar una respuesta si se pide otra vez, sin cambiar la marca", async () => {
    const [ref, replyId] = [uuid(), uuid()];
    await handle(replyRequest(ref, replyId), env, fakeFetch().fetcher);
    await handle(syncRequest([ref]), env, failingFetch);
    await env.DB.prepare("UPDATE replies SET delivered_at = 1 WHERE reply_id = ?").bind(replyId).run();

    const response = await handle(syncRequest([ref]), env, failingFetch);
    const { replies } = await response.json<{ replies: Array<{ delivered_at: number | null }> }>();
    expect(replies).toHaveLength(1);
    expect(replies[0]?.delivered_at).toBe(1);
    const mark = await env.DB.prepare("SELECT delivered_at FROM replies WHERE reply_id = ?")
      .bind(replyId)
      .first("delivered_at");
    expect(mark).toBe(1);
  });

  it("aplica el rate limit por IP", async () => {
    const keys: string[] = [];
    const limited = {
      ...env,
      RATE_LIMITER: {
        limit: async ({ key }: { key: string }) => {
          keys.push(key);
          return { success: false };
        },
      },
    };
    const request = post("/v1/sync", { refs: [uuid()] }, { "cf-connecting-ip": "203.0.113.1" });
    const response = await handle(request, limited, failingFetch);
    expect(response.status).toBe(429);
    expect(keys).toEqual(["203.0.113.1"]);
  });
});

describe("POST /v1/delete", () => {
  it.each([
    ["sin refs", {}],
    ["ref inválido", { refs: ["x"] }],
    ["demasiados refs", { refs: Array.from({ length: 21 }, uuid) }],
  ])("rechaza %s", async (_name, body) => {
    const response = await handle(post("/v1/delete", body), env, failingFetch);
    expect(response.status).toBe(400);
  });

  it("borra las respuestas y el token de esos refs, y nada más", async () => {
    const [mine, other] = [uuid(), uuid()];
    await handle(syncRequest([mine, other], "token"), env, failingFetch);
    const { fetcher } = fakeFetch();
    await handle(replyRequest(mine, uuid()), env, fetcher);
    await handle(replyRequest(other, uuid()), env, fetcher);

    const response = await handle(post("/v1/delete", { refs: [mine.toUpperCase()] }), env, failingFetch);
    await expect(response.json()).resolves.toEqual({ status: "deleted" });

    const count = (table: string, ref: string) =>
      env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ref = ?`).bind(ref).first("n");
    await expect(count("replies", mine)).resolves.toBe(0);
    await expect(tokenFor(mine)).resolves.toBeNull();
    await expect(count("replies", other)).resolves.toBe(1);
    await expect(tokenFor(other)).resolves.toBe("token");
  });

  it("aplica el rate limit", async () => {
    const limited = { ...env, RATE_LIMITER: { limit: async () => ({ success: false }) } };
    const response = await handle(post("/v1/delete", { refs: [uuid()] }), limited, failingFetch);
    expect(response.status).toBe(429);
  });
});

describe("rutas", () => {
  it("responde 404 a lo que no existe", async () => {
    const response = await handle(new Request("https://replyback.test/v1/sync"), env, failingFetch);
    expect(response.status).toBe(404);
    const other = await handle(new Request("https://replyback.test/"), env, failingFetch);
    expect(other.status).toBe(404);
  });
});
