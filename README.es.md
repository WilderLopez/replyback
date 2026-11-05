# replyback

Responde dentro de tu app a los comentarios que los usuarios envían por Sentry.

Sentry recoge los comentarios, pero no ofrece un canal para contestar. replyback añade ese canal sin tocar
el backend de tu app y sin correo: respondes desde una CLI, un Cloudflare Worker guarda la respuesta y avisa
con un push, y la app muestra el comentario y su respuesta como un hilo.

[Read in English](README.md)

> [!NOTE]
> Proyecto en fase temprana: el SDK de iOS se probó en un iPhone real, pero aún no ha salido en una versión de
> la App Store. Android no tiene SDK, solo una [API documentada](docs/API.md).

## Datos

| Dato | Dónde vive |
|---|---|
| Comentario, respuesta, ID de usuario, token de push | Tu cuenta de Cloudflare, se borran tras 2 años sin actividad |
| Llaves para leerlos (`ref`) | Llavero de iCloud del dispositivo, por cuenta |
| Copia local de los hilos | Caché de la app, fuera de las copias de seguridad |
| Correo | replyback nunca lo guarda |

> [!IMPORTANT]
> Estos datos pasan a ser tu responsabilidad. Comprueba que tu política de privacidad los cubre, y llama a
> `deleteAllData()` en tu flujo de eliminar cuenta.

## Cómo empezar

Las guías detalladas están en inglés:

1. [Desplegar el Worker y configurar la CLI](docs/DEPLOY.md).
2. [Integrar el SDK de iOS](docs/INTEGRATION-IOS.md), o implementar la [API](docs/API.md) en otra plataforma.
3. Responder a tus usuarios:

```sh
pnpm replyback --deployment mi-app list --pending
pnpm replyback --deployment mi-app show PROYECTO-123
pnpm replyback --deployment mi-app reply PROYECTO-123 "Ya está corregido, gracias por avisar."
```

## Límites conocidos

- **Detector de spam de Sentry:** puede archivar comentarios reales por su cuenta, sin enviar alertas. Usa
  `replyback list`, que los marca como `[archived]`.
- **Sentry tarda unos minutos** en mostrar un comentario nuevo.
- **Las llaves dependen del Llavero de iCloud:** sin él, o al pasar a otro Apple ID o a Android, el usuario pierde
  el acceso a su historial.
- **Los comentarios sin responder son locales:** la CLI sube el comentario al responder, así que uno sin
  respuesta no aparece en otro dispositivo.

Las decisiones de diseño están en [docs/diseno.md](docs/diseno.md).

## Licencia

[MIT](LICENSE)
