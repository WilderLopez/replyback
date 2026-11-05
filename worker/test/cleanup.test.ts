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
  it("nunca borra el histórico", async () => {
    const [delivered, undelivered] = [await insertReply(3000, 3000), await insertReply(3000, null)];
    await cleanup(env, NOW);
    await expect(replyExists(delivered)).resolves.toBe(true);
    await expect(replyExists(undelivered)).resolves.toBe(true);
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
