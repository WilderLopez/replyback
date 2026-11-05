import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { replyId } from "./ref.ts";
import { getComment, listComments, SentryError, type Comment, type SentryConfig } from "./sentry.ts";
import { fetchReplies, sendReply, WorkerError, type StoredReply, type WorkerConfig } from "./worker.ts";

const MAX_TEXT_LENGTH = 4000;
const PREVIEW_LENGTH = 60;

const USAGE = `Uso: replyback [--deployment <nombre>] <comando>

  list [--pending] [--all]            Lista los comentarios. --pending oculta los ya respondidos,
                                      --all incluye los resueltos en Sentry.
  show <issue>                        Muestra un comentario y sus respuestas.
  reply <issue> "texto" [--yes]       Responde. Pide confirmación salvo con --yes.
  reply <issue> --file <ruta> [--yes] Lee el texto de un fichero.

<issue> es el ID corto de Sentry. La configuración se lee del entorno o de
deployments/<nombre>/.env (ver deployments/example/.env.example).`;

export interface Deps {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  out: (text: string) => void;
  err: (text: string) => void;
  /** Devuelve null si no hay nadie a quien preguntar. */
  confirm: (question: string) => Promise<boolean | null>;
}

interface Config {
  sentry: SentryConfig;
  worker: WorkerConfig;
}

class UsageError extends Error {}

function loadConfig(env: Deps["env"]): Config {
  const names = ["SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT", "REPLYBACK_URL", "REPLYBACK_ADMIN_TOKEN"];
  const missing = names.filter((name) => !env[name]);
  if (missing.length > 0) throw new UsageError(`Falta configuración: ${missing.join(", ")}`);
  return {
    sentry: {
      url: (env["SENTRY_URL"] ?? "https://sentry.io").replace(/\/$/, ""),
      token: env["SENTRY_AUTH_TOKEN"] ?? "",
      org: env["SENTRY_ORG"] ?? "",
      project: env["SENTRY_PROJECT"] ?? "",
    },
    worker: { url: (env["REPLYBACK_URL"] ?? "").replace(/\/$/, ""), adminToken: env["REPLYBACK_ADMIN_TOKEN"] ?? "" },
  };
}

const targetLabel = (comment: Comment): string =>
  ({ ref: "con ref", legacy: "antiguo", none: "sin vía" })[comment.target.kind];

const refOf = (comment: Comment): string | null => (comment.target.kind === "none" ? null : comment.target.ref);

function replyState(replies: StoredReply[]): string {
  if (replies.length === 0) return "sin responder";
  return replies.some((reply) => reply.delivered_at !== null) ? "entregada" : "respondida";
}

const oneLine = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_LENGTH ? `${flat.slice(0, PREVIEW_LENGTH)}…` : flat;
};

const dateOf = (ms: number | null): string => (ms === null ? "no" : new Date(ms).toISOString().slice(0, 10));

async function list(config: Config, deps: Deps, pending: boolean, all: boolean): Promise<number> {
  const comments = await listComments(config.sentry, deps.fetch, all);
  // Dos comentarios antiguos de la misma persona y teléfono comparten `ref`.
  const refs = [...new Set(comments.flatMap((comment) => refOf(comment) ?? []))];
  const replies = await fetchReplies(config.worker, deps.fetch, refs);

  const rows = comments
    .map((comment) => ({ comment, state: replyState(replies.get(refOf(comment) ?? "") ?? []) }))
    .filter(({ state }) => !pending || state === "sin responder");

  if (rows.length === 0) {
    deps.out("No hay comentarios.");
    return 0;
  }
  const width = Math.max(...rows.map(({ comment }) => comment.shortId.length));
  for (const { comment, state } of rows) {
    deps.out(
      [
        comment.shortId.padEnd(width),
        comment.date,
        comment.locale.padEnd(5),
        comment.release.padEnd(10),
        targetLabel(comment).padEnd(7),
        state.padEnd(13),
        `${comment.ignored ? "[archivado] " : ""}${oneLine(comment.text)}`,
      ].join("  "),
    );
  }
  return 0;
}

function printComment(deps: Deps, comment: Comment): void {
  deps.out(`Comentario: ${comment.shortId}`);
  deps.out(`Fecha:      ${comment.date}`);
  deps.out(`Idioma:     ${comment.locale}`);
  deps.out(`Versión:    ${comment.release}`);
  deps.out(`Tipo:       ${targetLabel(comment)}`);
  if (comment.ignored) deps.out("Estado:     archivado por Sentry, quizá como spam");
  deps.out("");
  deps.out(comment.text);
}

async function show(config: Config, deps: Deps, shortId: string): Promise<number> {
  const comment = await getComment(config.sentry, deps.fetch, shortId);
  if (!comment) {
    deps.err(`No existe el comentario ${shortId} en este proyecto.`);
    return 1;
  }
  printComment(deps, comment);
  const ref = refOf(comment);
  const replies = ref ? ((await fetchReplies(config.worker, deps.fetch, [ref])).get(ref) ?? []) : [];
  for (const reply of replies) {
    deps.out("");
    deps.out(`Respuesta del ${dateOf(reply.created_at)} (aviso: ${dateOf(reply.pushed_at)}, entregada: ${dateOf(reply.delivered_at)})`);
    deps.out(reply.text);
  }
  return 0;
}

const PUSH_MESSAGES: Record<string, string> = {
  sent: "aviso enviado",
  no_token: "sin aviso porque no hay token; se entrega cuando la app consulte",
  failed: "el aviso falló; repite este mismo comando para reintentarlo",
  invalid_token: "sin aviso porque el token ya no es válido; se entrega cuando la app consulte",
  not_configured: "sin aviso porque el Worker no tiene FCM configurado",
  already_sent: "ya estaba enviada; no se avisó otra vez",
  already_delivered: "ya estaba entregada; no se avisó otra vez",
};

async function reply(
  config: Config,
  deps: Deps,
  shortId: string,
  text: string,
  skipConfirmation: boolean,
): Promise<number> {
  if (text.length > MAX_TEXT_LENGTH) {
    deps.err(`El texto tiene ${text.length} caracteres; el máximo es ${MAX_TEXT_LENGTH}.`);
    return 1;
  }
  const comment = await getComment(config.sentry, deps.fetch, shortId);
  if (!comment) {
    deps.err(`No existe el comentario ${shortId} en este proyecto.`);
    return 1;
  }
  const ref = refOf(comment);
  if (!ref) {
    deps.err(`${comment.shortId} no se puede responder: no tiene ref ni los datos para derivarlo.`);
    return 1;
  }
  if (comment.eventCount !== 1) {
    deps.err(`${comment.shortId} agrupa ${comment.eventCount} eventos: la respuesta podría llegar a otra persona.`);
    return 1;
  }

  const existing = (await fetchReplies(config.worker, deps.fetch, [ref])).get(ref) ?? [];
  printComment(deps, comment);
  deps.out("");
  if (existing.length > 0) deps.out(`Atención: ya tiene ${existing.length} respuesta(s).`);
  deps.out("Respuesta:");
  deps.out(text);
  deps.out("");

  if (!skipConfirmation) {
    const confirmed = await deps.confirm("Escribe «enviar» para confirmar: ");
    if (confirmed === null) {
      deps.err("Sin enviar: no hay terminal para confirmar. Usa --yes solo si ya revisaste el texto.");
      return 1;
    }
    if (!confirmed) {
      deps.out("Sin enviar.");
      return 0;
    }
  }

  const result = await sendReply(config.worker, deps.fetch, { ref, reply_id: replyId(ref, text), text });
  deps.out(`Respuesta guardada: ${PUSH_MESSAGES[result.push] ?? result.push}.`);
  return result.push === "failed" ? 1 : 0;
}

export async function run(argv: string[], deps: Deps): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        deployment: { type: "string" },
        pending: { type: "boolean", default: false },
        all: { type: "boolean", default: false },
        yes: { type: "boolean", default: false },
        file: { type: "string" },
      },
    });
    const [command, shortId, inlineText] = positionals;

    if (command === "list" && !shortId) {
      return await list(loadConfig(deps.env), deps, values.pending, values.all);
    }
    if (command === "show" && shortId) {
      return await show(loadConfig(deps.env), deps, shortId);
    }
    if (command === "reply" && shortId && (inlineText === undefined) !== (values.file === undefined)) {
      const text = (inlineText ?? (await readFile(values.file ?? "", "utf8"))).trim();
      if (!text) throw new UsageError("El texto está vacío.");
      return await reply(loadConfig(deps.env), deps, shortId, text, values.yes);
    }
    deps.err(USAGE);
    return 2;
  } catch (error) {
    if (error instanceof UsageError || error instanceof SentryError || error instanceof WorkerError) {
      deps.err(error.message);
      return 1;
    }
    if (error instanceof Error && "code" in error) {
      deps.err(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }
}
