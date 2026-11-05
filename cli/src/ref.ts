import { createHash } from "node:crypto";

const REF_LINE = /^ref:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

function hashAsUuid(input: string): string {
  const hex = createHash("sha256").update(input, "utf8").digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** El SDK añade el `ref` como última línea. Solo vale esa: el resto lo escribió el usuario. */
export function splitRef(message: string): { text: string; ref: string | null } {
  const lines = message.trimEnd().split("\n");
  const match = REF_LINE.exec((lines.at(-1) ?? "").trim());
  if (!match?.[1]) return { text: message.trim(), ref: null };
  return { text: lines.slice(0, -1).join("\n").trim(), ref: match[1].toLowerCase() };
}

/** `ref` de un comentario anterior al SDK. La app calcula el mismo. Ver docs/diseno.md. */
export const legacyRef = (userId: string, deviceAppHash: string): string =>
  hashAsUuid(`replyback:${userId}:${deviceAppHash}`);

/** Mismo texto para el mismo `ref`, misma clave: repetir el envío no duplica la respuesta. */
export const replyId = (ref: string, text: string): string => hashAsUuid(`${ref}\n${text}`);
