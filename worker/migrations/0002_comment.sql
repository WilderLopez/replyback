-- Comentario original al que responde cada respuesta. Va por respuesta y no por `ref`, porque dos
-- comentarios antiguos de la misma persona y teléfono comparten `ref`.
ALTER TABLE replies ADD COLUMN comment TEXT;
ALTER TABLE replies ADD COLUMN comment_at INTEGER;

-- Dueño del comentario según Sentry. Lo envía la CLI, nunca la app, y nunca se devuelve a la app. Sirve
-- para borrar los datos de una cuenta sin sus llaves y para migrar a otro sistema.
ALTER TABLE replies ADD COLUMN user_id TEXT;
CREATE INDEX replies_user_id ON replies(user_id);
