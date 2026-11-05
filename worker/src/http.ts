const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/** UUID en minúsculas, o null. `UUID().uuidString` de Swift lo da en mayúsculas. */
export function normalizeUuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const lower = value.toLowerCase();
  return UUID.test(lower) ? lower : null;
}

export class BodyError extends Error {
  constructor(readonly status: 400 | 413) {
    super("invalid body");
  }
}

/** Lee el JSON sin pasar de `maxBytes`, aunque la petición no declare su tamaño. */
export async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) throw new BodyError(413);
  if (!request.body) throw new BodyError(400);

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new BodyError(413);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new BodyError(400);
  }
}
