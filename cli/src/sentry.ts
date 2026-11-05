// Lectura de comentarios con la API de Sentry. Esta herramienta nunca escribe en Sentry.

import { legacyRef, splitRef } from "./ref.ts";

const PAGE_SIZE = 100;
const MAX_ISSUES = 500;
const CONCURRENCY = 8;
const PERIOD = "90d";

export interface SentryConfig {
  url: string;
  token: string;
  org: string;
  project: string;
}

export type Target =
  | { kind: "ref"; ref: string }
  | { kind: "legacy"; ref: string }
  | { kind: "none" };

export interface Comment {
  shortId: string;
  date: string;
  commentAt: number;
  /** Solo para enviarlo al Worker: la CLI nunca lo muestra. */
  userId: string | null;
  locale: string;
  release: string;
  eventCount: number;
  /** Sentry lo archivó, normalmente porque su detector lo clasificó como spam. */
  ignored: boolean;
  text: string;
  target: Target;
}

interface RawIssue {
  id: string;
  shortId: string;
  count: string;
  firstSeen: string;
  status?: string;
}

interface RawEvent {
  user?: { id?: string | null } | null;
  contexts?: {
    feedback?: { message?: string };
    app?: { device_app_hash?: string };
    culture?: { locale?: string };
  };
  tags?: Array<{ key: string; value: string }>;
}

export class SentryError extends Error {
  status: number;

  constructor(status: number) {
    super(`Sentry responded ${status}`);
    this.status = status;
  }
}

async function getJson(config: SentryConfig, fetcher: typeof fetch, path: string): Promise<Response> {
  const response = await fetcher(`${config.url}/api/0/organizations/${config.org}${path}`, {
    headers: { authorization: `Bearer ${config.token}` },
  });
  if (!response.ok) throw new SentryError(response.status);
  return response;
}

/** Cursor de la siguiente página, según la cabecera `Link` de Sentry. */
function nextCursor(link: string | null): string | null {
  const next = link?.split(",").find((part) => part.includes('rel="next"'));
  if (!next?.includes('results="true"')) return null;
  return /cursor="([^"]+)"/.exec(next)?.[1] ?? null;
}

async function listIssues(config: SentryConfig, fetcher: typeof fetch, query: string): Promise<RawIssue[]> {
  const issues: RawIssue[] = [];
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams({
      project: config.project,
      query,
      statsPeriod: PERIOD,
      sort: "new",
      limit: String(PAGE_SIZE),
    });
    if (cursor) params.set("cursor", cursor);
    const response: Response = await getJson(config, fetcher, `/issues/?${params}`);
    issues.push(...((await response.json()) as RawIssue[]));
    cursor = nextCursor(response.headers.get("link"));
  } while (cursor && issues.length < MAX_ISSUES);
  return issues;
}

function target(ref: string | null, event: RawEvent): Target {
  if (ref) return { kind: "ref", ref };
  const userId = event.user?.id;
  const deviceAppHash = event.contexts?.app?.device_app_hash;
  if (userId && deviceAppHash) return { kind: "legacy", ref: legacyRef(userId, deviceAppHash) };
  return { kind: "none" };
}

async function toComment(config: SentryConfig, fetcher: typeof fetch, issue: RawIssue): Promise<Comment> {
  const response = await getJson(config, fetcher, `/issues/${issue.id}/events/latest/`);
  const event = (await response.json()) as RawEvent;
  const { text, ref } = splitRef(event.contexts?.feedback?.message ?? "");
  const release = event.tags?.find((tag) => tag.key === "release")?.value ?? "";
  return {
    shortId: issue.shortId,
    date: issue.firstSeen.slice(0, 10),
    commentAt: Date.parse(issue.firstSeen),
    userId: event.user?.id ?? null,
    locale: event.contexts?.culture?.locale ?? "",
    // `bundle@1.2.3+45`: solo interesa la versión.
    release: release.split("@").at(-1) ?? "",
    eventCount: Number(issue.count),
    ignored: issue.status === "ignored",
    text,
    target: target(ref, event),
  };
}

export async function listComments(
  config: SentryConfig,
  fetcher: typeof fetch,
  includeResolved: boolean,
): Promise<Comment[]> {
  // `is:unresolved` dejaría fuera lo que el detector de spam de Sentry archiva por su cuenta.
  const query = includeResolved ? "issue.category:feedback" : "!is:resolved issue.category:feedback";
  const issues = await listIssues(config, fetcher, query);
  const comments: Comment[] = [];
  for (let start = 0; start < issues.length; start += CONCURRENCY) {
    const batch = issues.slice(start, start + CONCURRENCY);
    comments.push(...(await Promise.all(batch.map((issue) => toComment(config, fetcher, issue)))));
  }
  return comments;
}

/** La consulta limita a comentarios de este proyecto: otro tipo de issue no se puede responder. */
export async function getComment(config: SentryConfig, fetcher: typeof fetch, shortId: string): Promise<Comment | null> {
  const wanted = shortId.toUpperCase();
  let issues: RawIssue[];
  try {
    issues = await listIssues(config, fetcher, `issue.category:feedback issue:${wanted}`);
  } catch (error) {
    // Sentry responde 400 si el ID corto no corresponde a ningún issue.
    if (error instanceof SentryError && error.status === 400) return null;
    throw error;
  }
  const issue = issues.find((candidate) => candidate.shortId.toUpperCase() === wanted);
  return issue ? toComment(config, fetcher, issue) : null;
}
