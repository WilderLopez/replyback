const STATUS_BATCH = 100;

export interface WorkerConfig {
  url: string;
  adminToken: string;
}

export interface StoredReply {
  reply_id: string;
  ref: string;
  text: string;
  comment: string | null;
  created_at: number;
  pushed_at: number | null;
  delivered_at: number | null;
}

export interface SendResult {
  status: string;
  push: string;
}

export class WorkerError extends Error {}

async function post(config: WorkerConfig, fetcher: typeof fetch, path: string, body: unknown): Promise<unknown> {
  const response = await fetcher(`${config.url}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.adminToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new WorkerError(`El Worker respondió ${response.status}`);
  return response.json();
}

export const sendReply = async (
  config: WorkerConfig,
  fetcher: typeof fetch,
  body: { ref: string; reply_id: string; text: string; comment: string; comment_at: number; user_id: string | null },
): Promise<SendResult> => (await post(config, fetcher, "/v1/admin/replies", body)) as SendResult;

export async function fetchReplies(
  config: WorkerConfig,
  fetcher: typeof fetch,
  refs: string[],
): Promise<Map<string, StoredReply[]>> {
  const byRef = new Map<string, StoredReply[]>();
  for (let start = 0; start < refs.length; start += STATUS_BATCH) {
    const batch = refs.slice(start, start + STATUS_BATCH);
    const { replies } = (await post(config, fetcher, "/v1/admin/replies/status", { refs: batch })) as {
      replies: StoredReply[];
    };
    for (const reply of replies) byRef.set(reply.ref, [...(byRef.get(reply.ref) ?? []), reply]);
  }
  return byRef;
}

export const deleteUser = async (config: WorkerConfig, fetcher: typeof fetch, userId: string): Promise<number> =>
  ((await post(config, fetcher, "/v1/admin/delete", { user_id: userId })) as { replies: number }).replies;
