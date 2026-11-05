import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { cleanup } from "../src/index";
import { uuid } from "./helpers";

const DAY = 24 * 3600 * 1000;
const NOW = 1_800_000_000_000;

const insertReply = async (createdDaysAgo: number, deliveredDaysAgo: number | null, ref = uuid()) => {
  const id = uuid();
  await env.DB.prepare("INSERT INTO replies (reply_id, ref, text, created_at, delivered_at) VALUES (?, ?, 'x', ?, ?)")
    .bind(id, ref, NOW - createdDaysAgo * DAY, deliveredDaysAgo === null ? null : NOW - deliveredDaysAgo * DAY)
    .run();
  return id;
};
const replyExists = async (id: string) =>
  (await env.DB.prepare("SELECT 1 AS found FROM replies WHERE reply_id = ?").bind(id).first("found")) === 1;

const insertToken = async (updatedDaysAgo: number, ref = uuid()) => {
  await env.DB.prepare("INSERT INTO tokens (ref, fcm_token, updated_at) VALUES (?, 't', ?)")
    .bind(ref, NOW - updatedDaysAgo * DAY)
    .run();
  return ref;
};
const tokenExists = async (ref: string) =>
  (await env.DB.prepare("SELECT 1 AS found FROM tokens WHERE ref = ?").bind(ref).first("found")) === 1;

describe("limpieza", () => {
  it("borra los hilos sin actividad en 730 días, entregados o no", async () => {
    const [delivered, undelivered] = [await insertReply(731, 731), await insertReply(731, null)];
    const recent = await insertReply(729, 729);
    await cleanup(env, NOW);
    await expect(replyExists(delivered)).resolves.toBe(false);
    await expect(replyExists(undelivered)).resolves.toBe(false);
    await expect(replyExists(recent)).resolves.toBe(true);
  });

  it("cuenta como actividad la última entrega y la última respuesta del ref", async () => {
    const lateDelivery = await insertReply(1000, 10);
    const ref = uuid();
    const [oldInThread, newInThread] = [await insertReply(1000, 1000, ref), await insertReply(10, null, ref)];
    await cleanup(env, NOW);
    await expect(replyExists(lateDelivery)).resolves.toBe(true);
    await expect(replyExists(oldInThread)).resolves.toBe(true);
    await expect(replyExists(newInThread)).resolves.toBe(true);
  });

  it("acepta otro plazo, e ignora uno inválido", async () => {
    const [old, recent] = [await insertReply(31, 31), await insertReply(29, 29)];
    await cleanup({ ...env, HISTORY_RETENTION_DAYS: "abc" }, NOW);
    await expect(replyExists(old)).resolves.toBe(true);
    await cleanup({ ...env, HISTORY_RETENTION_DAYS: "30" }, NOW);
    await expect(replyExists(old)).resolves.toBe(false);
    await expect(replyExists(recent)).resolves.toBe(true);
  });

  it("también borra el token de un hilo caducado", async () => {
    const ref = uuid();
    await insertReply(731, null, ref);
    await insertToken(181, ref);
    await cleanup(env, NOW);
    await expect(tokenExists(ref)).resolves.toBe(false);
  });

  it("borra los tokens viejos salvo los que tienen respuestas pendientes", async () => {
    const pendingRef = uuid();
    await insertReply(10, null, pendingRef);
    const [old, recent] = [await insertToken(181), await insertToken(179)];
    await insertToken(181, pendingRef);

    await cleanup(env, NOW);
    await expect(tokenExists(old)).resolves.toBe(false);
    await expect(tokenExists(recent)).resolves.toBe(true);
    await expect(tokenExists(pendingRef)).resolves.toBe(true);
  });
});
