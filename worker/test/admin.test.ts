import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handle } from "../src/index";
import { failingFetch, fakeFetch, post, replyRequest, sendCalls, syncRequest, unregisteredFetch, uuid } from "./helpers";

const registered = async (token = "device-token"): Promise<string> => {
  const ref = uuid();
  await handle(syncRequest([ref], token), env, failingFetch);
  return ref;
};

describe("POST /v1/admin/replies", () => {
  it.each([
    ["sin cabecera", {}],
    ["con otro token", { authorization: "Bearer otro" }],
    ["sin Bearer", { authorization: "test-admin-token" }],
  ])("rechaza %s", async (_name, headers) => {
    const body = { ref: uuid(), reply_id: uuid(), text: "x" };
    const response = await handle(post("/v1/admin/replies", body, headers), env, failingFetch);
    expect(response.status).toBe(401);
  });

  it("rechaza todo si el despliegue no tiene ADMIN_TOKEN", async () => {
    const response = await handle(replyRequest(uuid(), uuid()), { ...env, ADMIN_TOKEN: undefined }, failingFetch);
    expect(response.status).toBe(401);
  });

  it.each([
    ["ref inválido", { ref: "x", reply_id: uuid(), text: "x" }],
    ["reply_id inválido", { ref: uuid(), reply_id: "x", text: "x" }],
    ["sin texto", { ref: uuid(), reply_id: uuid() }],
    ["texto en blanco", { ref: uuid(), reply_id: uuid(), text: "  \n " }],
    ["texto demasiado largo", { ref: uuid(), reply_id: uuid(), text: "x".repeat(4001) }],
  ])("rechaza %s", async (_name, body) => {
    const request = post("/v1/admin/replies", body, { authorization: "Bearer test-admin-token" });
    const response = await handle(request, env, failingFetch);
    expect(response.status).toBe(400);
  });

  it("guarda la respuesta aunque no haya token, para entregarla en sync", async () => {
    const [ref, replyId] = [uuid(), uuid()];
    const response = await handle(replyRequest(ref, replyId, "Hola"), env, failingFetch);
    await expect(response.json()).resolves.toEqual({ status: "stored", push: "no_token" });

    const collected = await handle(syncRequest([ref]), env, failingFetch);
    const { replies } = await collected.json<{ replies: Array<{ text: string }> }>();
    expect(replies.map((reply) => reply.text)).toEqual(["Hola"]);
  });

  it("envía un aviso que no contiene ni la respuesta ni el ref", async () => {
    const ref = await registered();
    const { fetcher, calls } = fakeFetch();
    const response = await handle(replyRequest(ref, uuid(), "Texto privado"), env, fetcher);
    await expect(response.json()).resolves.toEqual({ status: "stored", push: "sent" });

    const [send] = sendCalls(calls);
    expect(send?.url).toBe("https://fcm.googleapis.com/v1/projects/demo-project/messages:send");
    expect(new Headers(send?.init.headers).get("authorization")).toBe("Bearer fake-access-token");

    const raw = String(send?.init.body);
    expect(raw).not.toContain("Texto privado");
    expect(raw).not.toContain(ref);
    const { message } = JSON.parse(raw);
    expect(message.token).toBe("device-token");
    expect(message.notification).toEqual({ title: env.PUSH_TITLE, body: env.PUSH_BODY });
    expect(message.data).toEqual({ type: "replyback.reply" });
  });

  it("firma el JWT de la cuenta de servicio", async () => {
    const ref = await registered();
    const { fetcher, calls } = fakeFetch();
    await handle(replyRequest(ref, uuid()), env, fetcher);

    const auth = calls.find((call) => call.url === "https://oauth2.googleapis.com/token");
    const params = auth?.init.body as URLSearchParams;
    expect(params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");

    const [header = "", claims = "", signature = ""] = (params.get("assertion") ?? "").split(".");
    const decode = (part: string) => Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    const text = (part: string) => JSON.parse(new TextDecoder().decode(decode(part)));

    expect(text(header)).toEqual({ alg: "RS256", typ: "JWT" });
    const decoded = text(claims);
    expect(decoded).toMatchObject({
      iss: "demo@demo-project.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
    });
    expect(decoded.exp - decoded.iat).toBe(3600);

    const key = await crypto.subtle.importKey(
      "jwk",
      JSON.parse(env.TEST_PUBLIC_JWK),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      decode(signature),
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(valid).toBe(true);
  });

  it("añade las claves de traducción si están configuradas", async () => {
    const ref = await registered();
    const { fetcher, calls } = fakeFetch();
    const localized = { ...env, PUSH_TITLE_LOC_KEY: "push_title", PUSH_BODY_LOC_KEY: "push_body" };
    await handle(replyRequest(ref, uuid()), localized, fetcher);

    const { message } = JSON.parse(String(sendCalls(calls)[0]?.init.body));
    expect(message.apns.payload.aps.alert).toEqual({
      title: env.PUSH_TITLE,
      body: env.PUSH_BODY,
      "title-loc-key": "push_title",
      "loc-key": "push_body",
    });
    expect(message.android.notification).toEqual({ title_loc_key: "push_title", body_loc_key: "push_body" });
  });

  it("repetir la petición no duplica la respuesta ni el aviso", async () => {
    const [ref, replyId] = [await registered(), uuid()];
    const { fetcher, calls } = fakeFetch();
    await handle(replyRequest(ref, replyId), env, fetcher);
    const again = await handle(replyRequest(ref, replyId), env, fetcher);

    await expect(again.json()).resolves.toEqual({ status: "duplicate", push: "already_sent" });
    expect(sendCalls(calls)).toHaveLength(1);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM replies WHERE reply_id = ?").bind(replyId).first("n");
    expect(count).toBe(1);
  });

  it("rechaza un reply_id repetido con otro contenido", async () => {
    const [ref, replyId] = [uuid(), uuid()];
    await handle(replyRequest(ref, replyId, "Uno"), env, failingFetch);
    const otherText = await handle(replyRequest(ref, replyId, "Dos"), env, failingFetch);
    expect(otherText.status).toBe(409);
    const otherRef = await handle(replyRequest(uuid(), replyId, "Uno"), env, failingFetch);
    expect(otherRef.status).toBe(409);
  });

  it("un fallo de FCM conserva la respuesta y se puede reintentar", async () => {
    const [ref, replyId] = [await registered(), uuid()];
    const failed = await handle(replyRequest(ref, replyId), env, fakeFetch(500).fetcher);
    await expect(failed.json()).resolves.toEqual({ status: "stored", push: "failed" });

    const { fetcher, calls } = fakeFetch();
    const retried = await handle(replyRequest(ref, replyId), env, fetcher);
    await expect(retried.json()).resolves.toEqual({ status: "duplicate", push: "sent" });
    expect(sendCalls(calls)).toHaveLength(1);
  });

  it("no vuelve a avisar si la respuesta ya se entregó", async () => {
    const [ref, replyId] = [await registered(), uuid()];
    await handle(replyRequest(ref, replyId), env, fakeFetch(500).fetcher);
    await handle(syncRequest([ref]), env, failingFetch);

    const retried = await handle(replyRequest(ref, replyId), env, failingFetch);
    await expect(retried.json()).resolves.toEqual({ status: "duplicate", push: "already_delivered" });
  });

  it("un fallo de red al enviar no rompe la petición", async () => {
    const ref = await registered();
    const fetcher = async () => {
      throw new TypeError("network");
    };
    const response = await handle(replyRequest(ref, uuid()), env, fetcher);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "stored", push: "failed" });
  });

  it("borra el token si FCM dice que ya no existe", async () => {
    const ref = await registered();
    const response = await handle(replyRequest(ref, uuid()), env, unregisteredFetch().fetcher);
    await expect(response.json()).resolves.toEqual({ status: "stored", push: "invalid_token" });
    const token = await env.DB.prepare("SELECT fcm_token FROM tokens WHERE ref = ?").bind(ref).first("fcm_token");
    expect(token).toBeNull();
  });

  it("conserva el token ante otro 404, como un proyecto mal configurado", async () => {
    const ref = await registered();
    const response = await handle(replyRequest(ref, uuid()), env, fakeFetch(404).fetcher);
    await expect(response.json()).resolves.toEqual({ status: "stored", push: "failed" });
    const token = await env.DB.prepare("SELECT fcm_token FROM tokens WHERE ref = ?").bind(ref).first("fcm_token");
    expect(token).toBe("device-token");
  });

  it.each([undefined, "no es json", "{}"])("avisa si la cuenta de servicio no sirve: %s", async (account) => {
    const ref = await registered();
    const response = await handle(replyRequest(ref, uuid()), { ...env, FCM_SERVICE_ACCOUNT: account }, failingFetch);
    await expect(response.json()).resolves.toEqual({ status: "stored", push: "not_configured" });
  });
});

describe("POST /v1/admin/replies/status", () => {
  const statusRequest = (body: unknown, token = "test-admin-token") =>
    post("/v1/admin/replies/status", body, { authorization: `Bearer ${token}` });

  it("exige el token de administración", async () => {
    const response = await handle(statusRequest({ refs: [] }, "otro"), env, failingFetch);
    expect(response.status).toBe(401);
  });

  it.each([
    ["sin refs", {}],
    ["ref inválido", { refs: ["x"] }],
    ["demasiados refs", { refs: Array.from({ length: 101 }, uuid) }],
  ])("rechaza %s", async (_name, body) => {
    const response = await handle(statusRequest(body), env, failingFetch);
    expect(response.status).toBe(400);
  });

  it("devuelve una lista vacía si no hay refs", async () => {
    const response = await handle(statusRequest({ refs: [] }), env, failingFetch);
    await expect(response.json()).resolves.toEqual({ replies: [] });
  });

  it("devuelve las respuestas de esos refs sin marcarlas como entregadas", async () => {
    const [ref, replyId] = [uuid(), uuid()];
    await handle(replyRequest(ref, replyId, "Hola"), env, failingFetch);
    await handle(replyRequest(uuid(), uuid(), "De otro"), env, failingFetch);

    const response = await handle(statusRequest({ refs: [ref] }), env, failingFetch);
    const { replies } = await response.json<{ replies: Array<Record<string, unknown>> }>();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ reply_id: replyId, ref, text: "Hola", delivered_at: null });
  });

  it("acepta el máximo de refs permitido", async () => {
    const response = await handle(statusRequest({ refs: Array.from({ length: 100 }, uuid) }), env, failingFetch);
    expect(response.status).toBe(200);
  });
});
