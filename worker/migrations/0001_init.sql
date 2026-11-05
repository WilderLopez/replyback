-- Las marcas de tiempo van en milisegundos Unix.
CREATE TABLE tokens (
  ref TEXT PRIMARY KEY,
  fcm_token TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE replies (
  reply_id TEXT PRIMARY KEY,
  ref TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  pushed_at INTEGER,
  delivered_at INTEGER
);

CREATE INDEX replies_ref ON replies(ref);
