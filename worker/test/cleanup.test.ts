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
  it("borra las entregadas viejas y conserva las recientes", async () => {
    const [old, recent] = [await insertReply(40, 31), await insertReply(40, 29)];
    await cleanup(env, NOW);
    await expect(replyExists(old)).resolves.toBe(false);
    await expect(replyExists(recent)).resolves.toBe(true);
  });

  it("da más plazo a las respuestas sin entregar", async () => {
    const [waiting, abandoned] = [await insertReply(179, null), await insertReply(181, null)];
    await cleanup(env, NOW);
    await expect(replyExists(waiting)).resolves.toBe(true);
    await expect(replyExists(abandoned)).resolves.toBe(false);
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
