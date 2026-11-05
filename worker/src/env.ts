/** Bindings de wrangler más los secretos y variables opcionales de cada despliegue. */
export interface AppEnv extends Env {
  ADMIN_TOKEN?: string;
  FCM_SERVICE_ACCOUNT?: string;
  PUSH_TITLE_LOC_KEY?: string;
  PUSH_BODY_LOC_KEY?: string;
  /** Días sin actividad tras los que se borra un hilo. Por defecto, 730. */
  HISTORY_RETENTION_DAYS?: string;
}
