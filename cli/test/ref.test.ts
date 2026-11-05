import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { legacyRef, replyId, splitRef } from "../src/ref.ts";

const REF = "11111111-2222-4333-8444-555555555555";

test("splitRef saca el ref de la última línea", () => {
  assert.deepEqual(splitRef(`Hola\nque tal\n\nref:${REF}\n\n`), { text: "Hola\nque tal", ref: REF });
});

test("splitRef normaliza a minúsculas", () => {
  assert.equal(splitRef(`Hola\nref:${REF.toUpperCase().replace(/-/g, "-")}`).ref, REF);
});

test("splitRef ignora un ref escrito antes de la última línea", () => {
  const message = `ref:${REF}\nTexto después`;
  assert.deepEqual(splitRef(message), { text: message, ref: null });
});

test("splitRef ignora lo que no es un UUID", () => {
  assert.equal(splitRef("Hola\nref:no-es-uuid").ref, null);
  assert.equal(splitRef("").ref, null);
});

test("legacyRef coincide con los vectores compartidos", () => {
  const url = new URL("../../spec/legacy-ref-vectors.json", import.meta.url);
  const vectors = JSON.parse(readFileSync(url, "utf8")) as Array<{ user_id: string; device_app_hash: string; ref: string }>;
  assert.ok(vectors.length > 0);
  for (const vector of vectors) {
    assert.equal(legacyRef(vector.user_id, vector.device_app_hash), vector.ref);
  }
});

test("replyId es estable y depende del ref y del texto", () => {
  assert.equal(replyId(REF, "Hola"), replyId(REF, "Hola"));
  assert.notEqual(replyId(REF, "Hola"), replyId(REF, "Adiós"));
  assert.notEqual(replyId(REF, "Hola"), replyId("11111111-2222-4333-8444-555555555556", "Hola"));
  assert.match(replyId(REF, "Hola"), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});
