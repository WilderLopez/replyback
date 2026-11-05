// Envío por FCM HTTP v1 con una cuenta de servicio de Firebase, sin dependencias.

import type { AppEnv } from "./env";

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const JWT_LIFETIME_S = 3600;

export type PushResult = "sent" | "invalid_token" | "failed" | "not_configured";
export type Fetch = typeof fetch;

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

function parseServiceAccount(raw: string | undefined): ServiceAccount | null {
  if (!raw) return null;
  try {
    const parsed: Partial<ServiceAccount> = JSON.parse(raw);
    const { project_id, client_email, private_key } = parsed;
    if (!project_id || !client_email || !private_key) return null;
    return { project_id, client_email, private_key };
  } catch {
    return null;
  }
}

function b64url(input: ArrayBuffer | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function signJwt(account: ServiceAccount, nowS: number): Promise<string> {
  const pem = account.private_key.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const der = Uint8Array.from(atob(pem), (char) => char.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: account.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: nowS,
      exp: nowS + JWT_LIFETIME_S,
    }),
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${claims}`),
  );
  return `${header}.${claims}.${b64url(signature)}`;
}

/** El aviso no lleva ni el texto de la respuesta ni el `ref`, que da acceso a ella. */
function message(token: string, env: AppEnv): object {
  const { PUSH_TITLE: title, PUSH_BODY: body, PUSH_TITLE_LOC_KEY: titleKey, PUSH_BODY_LOC_KEY: bodyKey } = env;
  const localized = titleKey || bodyKey;
  return {
    token,
    notification: { title, body },
    data: { type: "replyback.reply" },
    android: {
      priority: "HIGH",
      ...(localized && {
        notification: {
          ...(titleKey && { title_loc_key: titleKey }),
          ...(bodyKey && { body_loc_key: bodyKey }),
        },
      }),
    },
    apns: {
      payload: {
        aps: {
          sound: "default",
          ...(localized && {
            alert: {
              title,
              body,
              ...(titleKey && { "title-loc-key": titleKey }),
              ...(bodyKey && { "loc-key": bodyKey }),
            },
          }),
        },
      },
    },
  };
}

/** Un token inválido no es un error: se devuelve para que quien llama lo borre. */
export async function sendPush(token: string, env: AppEnv, fetcher: Fetch, nowMs: number): Promise<PushResult> {
  const account = parseServiceAccount(env.FCM_SERVICE_ACCOUNT);
  if (!account) return "not_configured";

  try {
    const assertion = await signJwt(account, Math.floor(nowMs / 1000));
    const auth = await fetcher(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
    if (!auth.ok) {
      console.error(JSON.stringify({ event: "fcm_auth_failed", status: auth.status }));
      return "failed";
    }
    const { access_token } = await auth.json<{ access_token: string }>();

    const send = await fetcher(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
      method: "POST",
      headers: { authorization: `Bearer ${access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ message: message(token, env) }),
    });
    if (send.ok) return "sent";
    // Un 404 también puede ser un proyecto mal configurado: solo UNREGISTERED invalida el token.
    if (send.status === 404 && (await send.text()).includes("UNREGISTERED")) return "invalid_token";
    console.error(JSON.stringify({ event: "fcm_send_failed", status: send.status }));
    return "failed";
  } catch (error) {
    console.error(JSON.stringify({ event: "fcm_error", name: error instanceof Error ? error.name : "unknown" }));
    return "failed";
  }
}
