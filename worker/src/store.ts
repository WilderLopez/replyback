export interface Reply {
  reply_id: string;
  ref: string;
  text: string;
  created_at: number;
  pushed_at: number | null;
  delivered_at: number | null;
}

export type DeliveredReply = Pick<Reply, "reply_id" | "ref" | "text" | "created_at">;

export class Store {
  constructor(private readonly db: D1Database) {}

  async saveToken(refs: string[], token: string, now: number): Promise<void> {
    const insert = this.db.prepare(
      `INSERT INTO tokens (ref, fcm_token, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(ref) DO UPDATE SET fcm_token = excluded.fcm_token, updated_at = excluded.updated_at`,
    );
    await this.db.batch(refs.map((ref) => insert.bind(ref, token, now)));
  }

  async token(ref: string): Promise<string | null> {
    return this.db.prepare("SELECT fcm_token FROM tokens WHERE ref = ?").bind(ref).first<string>("fcm_token");
  }

  async deleteToken(ref: string): Promise<void> {
    await this.db.prepare("DELETE FROM tokens WHERE ref = ?").bind(ref).run();
  }

  /** Devuelve las respuestas y marca las nuevas como entregadas. La app elimina duplicados por `reply_id`. */
  async collect(refs: string[], now: number): Promise<DeliveredReply[]> {
    const marks = refs.map(() => "?").join(", ");
    const { results } = await this.db
      .prepare(`SELECT reply_id, ref, text, created_at FROM replies WHERE ref IN (${marks}) ORDER BY created_at`)
      .bind(...refs)
      .all<DeliveredReply>();
    if (results.length > 0) {
      await this.db
        .prepare(`UPDATE replies SET delivered_at = ? WHERE ref IN (${marks}) AND delivered_at IS NULL`)
        .bind(now, ...refs)
        .run();
    }
    return results;
  }

  /** Inserta la respuesta. Si el `reply_id` ya existe, devuelve la que había. */
  async saveReply(reply_id: string, ref: string, text: string, now: number): Promise<Reply | null> {
    const { meta } = await this.db
      .prepare(
        `INSERT INTO replies (reply_id, ref, text, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(reply_id) DO NOTHING`,
      )
      .bind(reply_id, ref, text, now)
      .run();
    if (meta.changes > 0) return null;
    return this.db.prepare("SELECT * FROM replies WHERE reply_id = ?").bind(reply_id).first<Reply>();
  }

  async replies(refs: string[]): Promise<Reply[]> {
    const marks = refs.map(() => "?").join(", ");
    const { results } = await this.db
      .prepare(`SELECT * FROM replies WHERE ref IN (${marks}) ORDER BY created_at`)
      .bind(...refs)
      .all<Reply>();
    return results;
  }

  async markPushed(reply_id: string, now: number): Promise<void> {
    await this.db.prepare("UPDATE replies SET pushed_at = ? WHERE reply_id = ?").bind(now, reply_id).run();
  }

  /** Conserva los tokens de los `ref` con respuestas sin entregar. */
  async cleanup(limits: { delivered: number; undelivered: number; tokens: number }): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `DELETE FROM replies
           WHERE (delivered_at IS NOT NULL AND delivered_at < ?)
              OR (delivered_at IS NULL AND created_at < ?)`,
        )
        .bind(limits.delivered, limits.undelivered),
      this.db
        .prepare(
          `DELETE FROM tokens
           WHERE updated_at < ?
             AND ref NOT IN (SELECT ref FROM replies WHERE delivered_at IS NULL)`,
        )
        .bind(limits.tokens),
    ]);
  }
}
