import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { replyId } from "./ref.ts";
import { getComment, listComments, SentryError, type Comment, type SentryConfig } from "./sentry.ts";
import { deleteUser, fetchReplies, sendReply, WorkerError, type StoredReply, type WorkerConfig } from "./worker.ts";

const MAX_TEXT_LENGTH = 4000;
const PREVIEW_LENGTH = 60;

const USAGE = `Usage: replyback [--deployment <name>] <command>

  list [--pending] [--all]            Lists comments. --pending hides answered ones,
                                      --all includes those resolved in Sentry.
  show <issue>                        Shows a comment and its replies.
  reply <issue> "text" [--yes]        Replies. Asks for confirmation unless --yes.
  reply <issue> --file <path> [--yes] Reads the text from a file.
  forget <issue> [--yes]              Deletes from the Worker everything about the account
                                      that sent this comment.

<issue> is the Sentry short ID. Configuration comes from the environment or from
deployments/<name>/.env (see deployments/example/.env.example).`;

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
  if (missing.length > 0) throw new UsageError(`Missing configuration: ${missing.join(", ")}`);
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
  ({ ref: "ref", legacy: "legacy", none: "no route" })[comment.target.kind];

const refOf = (comment: Comment): string | null => (comment.target.kind === "none" ? null : comment.target.ref);

/** Dos comentarios antiguos pueden compartir `ref`: cada respuesta dice a cuál contesta. */
const repliesTo = (comment: Comment, byRef: Map<string, StoredReply[]>): StoredReply[] =>
  (byRef.get(refOf(comment) ?? "") ?? []).filter((reply) => reply.comment === null || reply.comment === comment.text);

function replyState(replies: StoredReply[]): string {
  if (replies.length === 0) return "unanswered";
  return replies.some((reply) => reply.delivered_at !== null) ? "delivered" : "replied";
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
    .map((comment) => ({ comment, state: replyState(repliesTo(comment, replies)) }))
    .filter(({ state }) => !pending || state === "unanswered");

  if (rows.length === 0) {
    deps.out("No comments.");
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
        `${comment.ignored ? "[archived] " : ""}${oneLine(comment.text)}`,
      ].join("  "),
    );
  }
  return 0;
}

function printComment(deps: Deps, comment: Comment): void {
  deps.out(`Comment:  ${comment.shortId}`);
  deps.out(`Date:     ${comment.date}`);
  deps.out(`Locale:   ${comment.locale}`);
  deps.out(`Version:  ${comment.release}`);
  deps.out(`Type:     ${targetLabel(comment)}`);
  if (comment.ignored) deps.out("Status:   archived by Sentry, possibly as spam");
  deps.out("");
  deps.out(comment.text);
}

async function show(config: Config, deps: Deps, shortId: string): Promise<number> {
  const comment = await getComment(config.sentry, deps.fetch, shortId);
  if (!comment) {
    deps.err(`Comment ${shortId} not found in this project.`);
    return 1;
  }
  printComment(deps, comment);
  const ref = refOf(comment);
  const replies = ref ? repliesTo(comment, await fetchReplies(config.worker, deps.fetch, [ref])) : [];
  for (const reply of replies) {
    deps.out("");
    deps.out(`Reply on ${dateOf(reply.created_at)} (push: ${dateOf(reply.pushed_at)}, delivered: ${dateOf(reply.delivered_at)})`);
    deps.out(reply.text);
  }
  return 0;
}

const PUSH_MESSAGES: Record<string, string> = {
  sent: "push sent",
  no_token: "no push because there is no token; it will be delivered when the app checks",
  failed: "the push failed; run this same command again to retry",
  invalid_token: "no push because the token is no longer valid; it will be delivered when the app checks",
  not_configured: "no push because the Worker has no FCM configuration",
  already_sent: "already sent; no new push",
  already_delivered: "already delivered; no new push",
};

async function reply(
  config: Config,
  deps: Deps,
  shortId: string,
  text: string,
  skipConfirmation: boolean,
): Promise<number> {
  if (text.length > MAX_TEXT_LENGTH) {
    deps.err(`The text has ${text.length} characters; the maximum is ${MAX_TEXT_LENGTH}.`);
    return 1;
  }
  const comment = await getComment(config.sentry, deps.fetch, shortId);
  if (!comment) {
    deps.err(`Comment ${shortId} not found in this project.`);
    return 1;
  }
  const ref = refOf(comment);
  if (!ref) {
    deps.err(`${comment.shortId} cannot be answered: it has no ref and no data to derive one.`);
    return 1;
  }
  if (comment.eventCount !== 1) {
    deps.err(`${comment.shortId} groups ${comment.eventCount} events: the reply could reach someone else.`);
    return 1;
  }

  const existing = repliesTo(comment, await fetchReplies(config.worker, deps.fetch, [ref]));
  printComment(deps, comment);
  deps.out("");
  if (existing.length > 0) deps.out(`Warning: it already has ${existing.length} reply(ies).`);
  deps.out("Reply:");
  deps.out(text);
  deps.out("");

  if (!skipConfirmation) {
    const confirmed = await deps.confirm("Type \"send\" to confirm: ");
    if (confirmed === null) {
      deps.err("Not sent: there is no terminal to confirm. Use --yes only if you already reviewed the text.");
      return 1;
    }
    if (!confirmed) {
      deps.out("Not sent.");
      return 0;
    }
  }

  const result = await sendReply(config.worker, deps.fetch, {
    ref,
    reply_id: replyId(ref, comment.text, text),
    text,
    comment: comment.text,
    comment_at: comment.commentAt,
    user_id: comment.userId,
  });
  deps.out(`Reply saved: ${PUSH_MESSAGES[result.push] ?? result.push}.`);
  return result.push === "failed" ? 1 : 0;
}

async function forget(config: Config, deps: Deps, shortId: string, skipConfirmation: boolean): Promise<number> {
  const comment = await getComment(config.sentry, deps.fetch, shortId);
  if (!comment) {
    deps.err(`Comment ${shortId} not found in this project.`);
    return 1;
  }
  if (!comment.userId) {
    deps.err(`${comment.shortId} does not identify an account.`);
    return 1;
  }
  printComment(deps, comment);
  deps.out("");
  deps.out("This deletes everything the Worker holds for the account that sent this comment.");
  if (!skipConfirmation) {
    const confirmed = await deps.confirm("Type \"send\" to confirm: ");
    if (confirmed === null) {
      deps.err("Not deleted: there is no terminal to confirm. Use --yes only if you already reviewed it.");
      return 1;
    }
    if (!confirmed) {
      deps.out("Not deleted.");
      return 0;
    }
  }
  deps.out(`Replies deleted: ${await deleteUser(config.worker, deps.fetch, comment.userId)}.`);
  return 0;
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
    if (command === "forget" && shortId && !inlineText) {
      return await forget(loadConfig(deps.env), deps, shortId, values.yes);
    }
    if (command === "reply" && shortId && (inlineText === undefined) !== (values.file === undefined)) {
      const text = (inlineText ?? (await readFile(values.file ?? "", "utf8"))).trim();
      if (!text) throw new UsageError("The text is empty.");
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
