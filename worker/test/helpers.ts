import type { Fetch } from "../src/fcm";

const ADMIN_TOKEN = "test-admin-token";

export const uuid = (): string => crypto.randomUUID();

export function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://replyback.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export const syncRequest = (refs: unknown, fcmToken?: unknown): Request =>
  post("/v1/sync", { refs, ...(fcmToken !== undefined && { fcm_token: fcmToken }) });

export const replyRequest = (ref: string, replyId: string, text = "Texto inventado"): Request =>
  post("/v1/admin/replies", { ref, reply_id: replyId, text }, { authorization: `Bearer ${ADMIN_TOKEN}` });

export interface FakeCall {
  url: string;
  init: RequestInit;
}

const UNREGISTERED_BODY = {
  error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] },
};

/** Sustituye a Google y a FCM. Sin `sendStatus` responde 200. */
export function fakeFetch(sendStatus = 200, sendBody: unknown = { name: "projects/demo-project/messages/1" }): {
  fetcher: Fetch;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const fetcher: Fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url.startsWith("https://oauth2.googleapis.com/")) {
      return Response.json({ access_token: "fake-access-token", expires_in: 3600 });
    }
    return Response.json(sendBody, { status: sendStatus });
  };
  return { fetcher, calls };
}

export const unregisteredFetch = (): { fetcher: Fetch; calls: FakeCall[] } => fakeFetch(404, UNREGISTERED_BODY);

export const sendCalls = (calls: FakeCall[]): FakeCall[] =>
  calls.filter((call) => call.url.startsWith("https://fcm.googleapis.com/"));

export const failingFetch: Fetch = async () => {
  throw new Error("no debería llamarse");
};
