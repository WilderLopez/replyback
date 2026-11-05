import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run, type Deps } from "../src/cli.ts";
import { legacyRef, replyId } from "../src/ref.ts";

// Todo inventado. Los datos personales están para comprobar que nunca se imprimen.
const REF = "11111111-2222-4333-8444-555555555555";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const EMAIL = "persona@example.com";
const USERNAME = "persona-inventada";
const DEVICE = "0123456789abcdef0123456789abcdef01234567";
const LEGACY_REF = legacyRef(USER_ID, DEVICE);

const ENV = {
  SENTRY_AUTH_TOKEN: "sentry-token",
  SENTRY_ORG: "demo-org",
  SENTRY_PROJECT: "demo-app",
  REPLYBACK_URL: "https://replyback.test/",
  REPLYBACK_ADMIN_TOKEN: "admin-token",
};

interface FakeIssue {
  id: string;
  shortId: string;
  count: string;
  firstSeen: string;
  message: string;
  withUser?: boolean;
  status?: string;
}

const issues: Record<string, FakeIssue> = {
  withRef: { id: "1", shortId: "DEMO-A", count: "1", firstSeen: "2026-10-01T10:00:00Z", message: `Comentario con ref\n\nref:${REF}` },
  legacy: { id: "2", shortId: "DEMO-B", count: "1", firstSeen: "2026-09-01T10:00:00Z", message: "Comentario antiguo" },
  noPath: { id: "3", shortId: "DEMO-C", count: "1", firstSeen: "2026-08-01T10:00:00Z", message: "Sin datos", withUser: false },
  grouped: { id: "4", shortId: "DEMO-D", count: "3", firstSeen: "2026-07-01T10:00:00Z", message: "Agrupado" },
  archived: { id: "5", shortId: "DEMO-E", count: "1", firstSeen: "2026-06-01T10:00:00Z", message: "Parece spam", status: "ignored" },
};

function harness(options: { replies?: unknown[]; confirm?: boolean | null; sendPush?: string; link?: string; workerStatus?: number } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const deps: Deps = {
    env: ENV,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    confirm: async () => options.confirm ?? null,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url: String(input), init });

      if (url.host === "sentry.io") {
        const list = /\/issues\/$/.test(url.pathname);
        if (list) {
          const wanted = /issue:(\S+)/.exec(url.searchParams.get("query") ?? "")?.[1];
          const found = Object.values(issues).filter((issue) => !wanted || issue.shortId === wanted);
          // La cabecera solo va en la primera página.
          const link = url.searchParams.has("cursor") ? "" : (options.link ?? "");
          return Response.json(found, { headers: { link } });
        }
        const id = /\/issues\/(\d+)\/events\/latest\/$/.exec(url.pathname)?.[1];
        const issue = Object.values(issues).find((candidate) => candidate.id === id);
        assert.ok(issue);
        return Response.json({
          user: issue.withUser === false ? null : { id: USER_ID, email: EMAIL, username: USERNAME },
          contexts: {
            feedback: { message: issue.message, contact_email: EMAIL, name: USERNAME },
            app: issue.withUser === false ? {} : { device_app_hash: DEVICE },
            culture: { locale: "es_US" },
          },
          tags: [{ key: "release", value: "com.example.app@1.2.3+45" }, { key: "user.email", value: EMAIL }],
        });
      }
      if (options.workerStatus) return new Response("{}", { status: options.workerStatus });
      if (url.pathname === "/v1/admin/replies/status") return Response.json({ replies: options.replies ?? [] });
      if (url.pathname === "/v1/admin/replies") {
        return Response.json({ status: "stored", push: options.sendPush ?? "sent" });
      }
      throw new Error(`Llamada inesperada: ${url}`);
    }) as typeof fetch,
  };
  const sends = () => calls.filter((call) => call.url === "https://replyback.test/v1/admin/replies");
  return { deps, out, err, calls, sends };
}

const assertNoPersonalData = (lines: string[]) => {
  const text = lines.join("\n");
  for (const secret of [EMAIL, USERNAME, USER_ID, DEVICE]) assert.ok(!text.includes(secret), `se imprimió ${secret}`);
};

test("list consulta solo comentarios del proyecto y no imprime datos personales", async () => {
  const h = harness();
  assert.equal(await run(["list"], h.deps), 0);

  const search = new URL(h.calls[0]?.url ?? "");
  assert.equal(search.pathname, "/api/0/organizations/demo-org/issues/");
  assert.equal(search.searchParams.get("project"), "demo-app");
  assert.equal(search.searchParams.get("query"), "!is:resolved issue.category:feedback");
  assert.equal(new Headers(h.calls[0]?.init?.headers).get("authorization"), "Bearer sentry-token");

  assert.equal(h.out.length, 5);
  assert.match(h.out[4] ?? "", /DEMO-E.*\[archivado\] Parece spam/);
  assert.ok(!(h.out[3] ?? "").includes("[archivado]"));
  assert.match(h.out[0] ?? "", /DEMO-A.*2026-10-01.*es_US.*1\.2\.3\+45.*con ref.*sin responder.*Comentario con ref/);
  assert.match(h.out[1] ?? "", /DEMO-B.*antiguo/);
  assert.match(h.out[2] ?? "", /DEMO-C.*sin vía/);
  assertNoPersonalData([...h.out, ...h.err]);
  assert.ok(!(h.out[0] ?? "").includes(REF), "el ref da acceso a la respuesta");
});

test("list --all incluye los resueltos", async () => {
  const h = harness();
  await run(["list", "--all"], h.deps);
  assert.equal(new URL(h.calls[0]?.url ?? "").searchParams.get("query"), "issue.category:feedback");
});

test("list consulta el estado por ref, incluidos los derivados", async () => {
  const h = harness();
  await run(["list"], h.deps);
  const status = h.calls.find((call) => call.url.endsWith("/v1/admin/replies/status"));
  const { refs } = JSON.parse(String(status?.init?.body)) as { refs: string[] };
  // DEMO-B y DEMO-D son de la misma persona y teléfono: comparten ref y se consulta una vez.
  assert.deepEqual(refs.sort(), [LEGACY_REF, REF].sort());
  assert.equal(new Headers(status?.init?.headers).get("authorization"), "Bearer admin-token");
});

test("list --pending oculta los ya respondidos y muestra el estado de los demás", async () => {
  const stored = { reply_id: "r", ref: REF, text: "t", created_at: 1, pushed_at: 1, delivered_at: 2 };
  const shown = harness({ replies: [stored] });
  await run(["list"], shown.deps);
  assert.match(shown.out[0] ?? "", /DEMO-A.*entregada/);

  const pending = harness({ replies: [stored] });
  await run(["list", "--pending"], pending.deps);
  assert.ok(!pending.out.join("\n").includes("DEMO-A"));
  assert.ok(pending.out.join("\n").includes("DEMO-B"));
});

test("list sigue la paginación solo mientras haya resultados", async () => {
  const searches = async (link: string) => {
    const h = harness({ link });
    await run(["list"], h.deps);
    return h.calls.map((call) => new URL(call.url)).filter((url) => url.pathname.endsWith("/issues/"));
  };
  const page = (results: boolean) =>
    `<https://sentry.io/x>; rel="previous"; results="false"; cursor="0:0:1", <https://sentry.io/x>; rel="next"; results="${results}"; cursor="0:100:0"`;

  const more = await searches(page(true));
  assert.equal(more.length, 2);
  assert.equal(more[1]?.searchParams.get("cursor"), "0:100:0");

  assert.equal((await searches(page(false))).length, 1);
});

test("show muestra el comentario sin el ref y sus respuestas", async () => {
  const stored = { reply_id: "r", ref: REF, text: "Ya está corregido", created_at: 0, pushed_at: null, delivered_at: null };
  const h = harness({ replies: [stored] });
  assert.equal(await run(["show", "DEMO-A"], h.deps), 0);
  const text = h.out.join("\n");
  assert.ok(text.includes("Comentario con ref"));
  assert.ok(text.includes("Ya está corregido"));
  assert.ok(!text.includes(REF));
  assertNoPersonalData(h.out);
  assert.match(new URL(h.calls[0]?.url ?? "").searchParams.get("query") ?? "", /issue\.category:feedback issue:DEMO-A/);
});

test("show avisa si Sentry archivó el comentario", async () => {
  const h = harness();
  await run(["show", "DEMO-E"], h.deps);
  assert.ok(h.out.join("\n").includes("archivado por Sentry"));
});

test("show avisa si el comentario no existe", async () => {
  const h = harness();
  assert.equal(await run(["show", "DEMO-Z"], h.deps), 1);
  assert.match(h.err[0] ?? "", /No existe/);
});

test("show trata como inexistente el 400 de Sentry y no otros errores", async () => {
  const withStatus = (status: number) => {
    const h = harness();
    h.deps.fetch = (async () => new Response("{}", { status })) as typeof fetch;
    return h;
  };
  const unknown = withStatus(400);
  assert.equal(await run(["show", "DEMO-Z"], unknown.deps), 1);
  assert.match(unknown.err[0] ?? "", /No existe/);

  const denied = withStatus(403);
  assert.equal(await run(["show", "DEMO-A"], denied.deps), 1);
  assert.match(denied.err[0] ?? "", /Sentry respondió 403/);
});

test("reply envía a un comentario con ref tras confirmar", async () => {
  const h = harness({ confirm: true });
  assert.equal(await run(["reply", "DEMO-A", "Ya está corregido"], h.deps), 0);
  const [send] = h.sends();
  assert.deepEqual(JSON.parse(String(send?.init?.body)), {
    ref: REF,
    reply_id: replyId(REF, "Ya está corregido"),
    text: "Ya está corregido",
  });
  assert.match(h.out.at(-1) ?? "", /aviso enviado/);
  assertNoPersonalData([...h.out, ...h.err]);
});

test("reply deriva el ref de un comentario antiguo", async () => {
  const h = harness({ confirm: true, sendPush: "no_token" });
  assert.equal(await run(["reply", "DEMO-B", "Hola"], h.deps), 0);
  assert.equal(JSON.parse(String(h.sends()[0]?.init?.body)).ref, LEGACY_REF);
  assert.match(h.out.at(-1) ?? "", /cuando la app consulte/);
});

test("reply no envía si se responde otra cosa a la confirmación", async () => {
  const h = harness({ confirm: false });
  assert.equal(await run(["reply", "DEMO-A", "Hola"], h.deps), 0);
  assert.equal(h.sends().length, 0);
  assert.equal(h.out.at(-1), "Sin enviar.");
});

test("reply no envía sin terminal y sin --yes", async () => {
  const h = harness({ confirm: null });
  assert.equal(await run(["reply", "DEMO-A", "Hola"], h.deps), 1);
  assert.equal(h.sends().length, 0);
  assert.ok(h.out.join("\n").includes("Hola"), "muestra lo que se habría enviado");
});

test("reply --yes no pregunta", async () => {
  const h = harness({ confirm: false });
  assert.equal(await run(["reply", "DEMO-A", "Hola", "--yes"], h.deps), 0);
  assert.equal(h.sends().length, 1);
});

test("reply avisa si ya hay respuestas", async () => {
  const stored = { reply_id: "r", ref: REF, text: "t", created_at: 1, pushed_at: 1, delivered_at: null };
  const h = harness({ confirm: false, replies: [stored] });
  await run(["reply", "DEMO-A", "Hola"], h.deps);
  assert.ok(h.out.join("\n").includes("ya tiene 1 respuesta"));
});

test("reply lee el texto de un fichero", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "replyback-")), "texto.txt");
  writeFileSync(file, "Texto del fichero\n");
  const h = harness();
  assert.equal(await run(["reply", "DEMO-A", "--file", file, "--yes"], h.deps), 0);
  assert.equal(JSON.parse(String(h.sends()[0]?.init?.body)).text, "Texto del fichero");
});

test("reply rechaza un comentario sin vía de respuesta", async () => {
  const h = harness({ confirm: true });
  assert.equal(await run(["reply", "DEMO-C", "Hola"], h.deps), 1);
  assert.equal(h.sends().length, 0);
  assert.match(h.err[0] ?? "", /no se puede responder/);
});

test("reply rechaza un issue con varios eventos", async () => {
  const h = harness({ confirm: true });
  assert.equal(await run(["reply", "DEMO-D", "Hola", "--yes"], h.deps), 1);
  assert.equal(h.sends().length, 0);
  assert.match(h.err[0] ?? "", /agrupa 3 eventos/);
});

test("reply rechaza textos vacíos o demasiado largos", async () => {
  const empty = harness();
  assert.equal(await run(["reply", "DEMO-A", "   ", "--yes"], empty.deps), 1);
  assert.equal(empty.sends().length, 0);

  const long = harness();
  assert.equal(await run(["reply", "DEMO-A", "x".repeat(4001), "--yes"], long.deps), 1);
  assert.equal(long.sends().length, 0);
});

test("reply devuelve error si el aviso falló, para reintentar", async () => {
  const h = harness({ sendPush: "failed" });
  assert.equal(await run(["reply", "DEMO-A", "Hola", "--yes"], h.deps), 1);
  assert.match(h.out.at(-1) ?? "", /reintentarlo/);
});

test("informa de los errores del Worker", async () => {
  const h = harness({ workerStatus: 401 });
  assert.equal(await run(["list"], h.deps), 1);
  assert.match(h.err[0] ?? "", /401/);
});

test("informa de la configuración que falta", async () => {
  const h = harness();
  h.deps.env = { ...ENV, SENTRY_AUTH_TOKEN: undefined, REPLYBACK_URL: undefined };
  assert.equal(await run(["list"], h.deps), 1);
  assert.match(h.err[0] ?? "", /SENTRY_AUTH_TOKEN, REPLYBACK_URL/);
});

test("muestra la ayuda ante un uso incorrecto", async () => {
  for (const argv of [[], ["otro"], ["show"], ["reply", "DEMO-A"], ["reply", "DEMO-A", "x", "--file", "y"], ["--desconocido"]]) {
    const h = harness();
    assert.equal(await run(argv, h.deps), 2, argv.join(" "));
    assert.ok(h.err.join("\n").includes("Uso: replyback"));
  }
});
