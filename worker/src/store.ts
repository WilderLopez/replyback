export interface Reply {
  reply_id: string;
  ref: string;
  text: string;
  comment: string | null;
  comment_at: number | null;
  user_id: string | null;
  created_at: number;
  pushed_at: number | null;
  delivered_at: number | null;
}

/** Lo que recibe la app: nunca `user_id`. */
export type DeliveredReply = Omit<Reply, "pushed_at" | "user_id">;

export interface NewReply {
  replyId: string;
  ref: string;
  text: string;
  comment: string;
  commentAt: number;
  userId: string | null;
}

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

  /**
   * Devuelve las respuestas y marca las nuevas como entregadas. `delivered_at` es el valor anterior a
   * esta consulta: si ya tenía fecha, otra instalación la recogió antes.
   */
  async collect(refs: string[], now: number): Promise<DeliveredReply[]> {
    const marks = refs.map(() => "?").join(", ");
    const { results } = await this.db
      .prepare(
        `SELECT reply_id, ref, text, comment, comment_at, created_at, delivered_at
         FROM replies WHERE ref IN (${marks}) ORDER BY created_at`,
      )
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
  async saveReply(reply: NewReply, now: number): Promise<Reply | null> {
    const { meta } = await this.db
      .prepare(
        `INSERT INTO replies (reply_id, ref, text, comment, comment_at, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(reply_id) DO NOTHING`,
      )
      .bind(reply.replyId, reply.ref, reply.text, reply.comment, reply.commentAt, reply.userId, now)
      .run();
    if (meta.changes > 0) return null;
    return this.db.prepare("SELECT * FROM replies WHERE reply_id = ?").bind(reply.replyId).first<Reply>();
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

  /** Borra todo lo de esos `ref`, por ejemplo al eliminar la cuenta en la app. */
  async deleteRefs(refs: string[]): Promise<void> {
    const marks = refs.map(() => "?").join(", ");
    await this.db.batch([
      this.db.prepare(`DELETE FROM replies WHERE ref IN (${marks})`).bind(...refs),
      this.db.prepare(`DELETE FROM tokens WHERE ref IN (${marks})`).bind(...refs),
    ]);
  }

  /** Borra todo lo de una cuenta, también si se perdieron sus llaves. Devuelve las filas borradas. */
  async deleteUser(userId: string): Promise<number> {
    const [, deleted] = await this.db.batch([
      this.db
        .prepare("DELETE FROM tokens WHERE ref IN (SELECT ref FROM replies WHERE user_id = ?)")
        .bind(userId),
      this.db.prepare("DELETE FROM replies WHERE user_id = ?").bind(userId),
    ]);
    return deleted?.meta.changes ?? 0;
  }

  /** El histórico no caduca. Solo se borran los tokens inactivos sin respuestas por entregar. */
  async cleanupTokens(before: number): Promise<void> {
    await this.db
      .prepare(
        `DELETE FROM tokens
         WHERE updated_at < ?
           AND ref NOT IN (SELECT ref FROM replies WHERE delivered_at IS NULL)`,
      )
      .bind(before)
      .run();
  }
}
