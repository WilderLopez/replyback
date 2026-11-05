# replyback

Responde dentro de tu app a los comentarios que los usuarios envían por Sentry.

Sentry recoge el comentario, pero no ofrece un canal para contestar. replyback añade ese canal sin
tocar el backend de la app y sin usar correo: respondes desde una CLI, un Cloudflare Worker guarda la
respuesta y avisa con un push, y la app la recoge y la muestra.

```text
App ── comentario + ref ──► Sentry
 │                            ▲
 │                            │ lee comentarios
 │                           CLI
 │                            │ envía la respuesta
 │                            ▼
 └───── POST /v1/sync ───►  Worker + D1 ──► FCM ──► push a la app
```

> [!NOTE]
> Proyecto en fase temprana, con SDK solo para iOS. El nombre es provisional.

## Cómo protege los datos

- **Referencia aleatoria:** cada comentario lleva un UUID generado en la app, y solo quien lo tiene
  puede leer sus respuestas. No se usa el ID de usuario, que no es secreto.
- **Push neutro:** ni la respuesta ni la referencia viajan en el aviso.
- **La nube como fuente de verdad:** el Worker guarda el comentario, la respuesta, el histórico y el ID de
  usuario, que nunca se devuelve a la app. No guarda el correo. El dispositivo guarda las llaves en el Llavero de iCloud y una caché.
- **Borrado:** la app puede borrar sus datos con `deleteAllData()`, y tú con `replyback forget <issue>`.
- **Solo lectura en Sentry:** la CLI nunca escribe allí, y no muestra correo ni ID de usuario.
- **Revisa tu política de privacidad:** estos datos se guardan en tu cuenta de Cloudflare, sin caducidad.

Los motivos de cada decisión están en [docs/diseno.md](docs/diseno.md).

## Qué necesitas

- Una cuenta de Cloudflare. Debería caber en el plan gratuito, cuya cuota es por cuenta.
- Un proyecto de Firebase con FCM configurado en tu app.
- Un proyecto de Sentry que reciba los comentarios de los usuarios.
- Node 22.18 o posterior, pnpm y, para el SDK, Xcode con Swift 6.

## Desplegar el Worker

```sh
make install
cp -R deployments/example deployments/mi-app   # queda fuera de git
cd worker
pnpm exec wrangler d1 create replyback-mi-app  # copia el ID en deployments/mi-app/wrangler.jsonc
```

Cambia también `name`, `database_name`, los textos del push y `namespace_id` en ese fichero, y luego:

```sh
pnpm exec wrangler d1 migrations apply replyback-mi-app --remote --config ../deployments/mi-app/wrangler.jsonc
pnpm exec wrangler deploy --config ../deployments/mi-app/wrangler.jsonc
pnpm exec wrangler secret put ADMIN_TOKEN --config ../deployments/mi-app/wrangler.jsonc
pnpm exec wrangler secret put FCM_SERVICE_ACCOUNT --config ../deployments/mi-app/wrangler.jsonc
```

`FCM_SERVICE_ACCOUNT` es el JSON de una cuenta de servicio de Firebase. Conviene crear una solo para
esto, con el rol **Firebase Cloud Messaging API Admin**.

## Usar la CLI

Copia `.env.example` a `.env` en `deployments/mi-app/` y rellénalo. El token de Sentry solo necesita el
permiso `event:read`.

```sh
pnpm replyback --deployment mi-app list --pending
pnpm replyback --deployment mi-app show PROYECTO-123
pnpm replyback --deployment mi-app reply PROYECTO-123 "Ya está corregido, gracias por avisar."
```

`reply` pide confirmación antes de enviar, y repetir el mismo texto no duplica la respuesta ni el aviso.

## Integrar el SDK de iOS

Añade este repo como paquete de Swift y crea un `ReplybackClient`. El SDK no depende de Sentry ni trae
interfaz: la app envía el mensaje por su canal y pinta las respuestas donde quiera.

```swift
let replyback = ReplybackClient(configuration: ReplybackConfiguration(workerURL: workerURL))

// Al iniciar sesión. Con `nil` al cerrarla: los datos se ocultan sin borrarse.
replyback.setAccount(userID: userID)

// Al enviar un comentario: `message` ya lleva la referencia.
let message = replyback.prepareComment(text)
SentrySDK.capture(feedback: SentryFeedback(message: message, name: name, email: email, source: .custom))
await replyback.sync(fcmToken: token)

// Al abrir la app o volver a ella.
await replyback.syncIfNeeded(fcmToken: token)

// Al recibir el push.
if ReplybackClient.isReplyNotification(userInfo) {
    await replyback.sync(fcmToken: token)
}

// Al eliminar la cuenta.
await replyback.deleteAllData()
```

`replyback.threads` y `replyback.unreadCount` son observables desde SwiftUI. Cada hilo trae el comentario
original y sus respuestas.

## Desarrollo

```sh
make check   # typecheck, tests del Worker, de la CLI y del SDK, y compilación para iOS
```

La documentación está en [docs/](docs/Inicio.md). Las reglas sobre qué nunca debe entrar al repo están
en [docs/publicacion.md](docs/publicacion.md).

## Licencia

[MIT](LICENSE)
