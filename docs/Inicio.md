---
tags: [inicio]
estado: idea
aliases: [replyback]
---

# replyback

Herramienta para responder, dentro de la propia app, a los comentarios que los usuarios envían
por Sentry. Sentry recoge el comentario pero no ofrece un canal para contestar; replyback pone
ese canal sin depender del backend de la app y sin usar correo.

## En una frase

La app envía un comentario con una referencia aleatoria. Quien da soporte responde a esa
referencia desde una CLI, un Cloudflare Worker guarda la respuesta y avisa con un push, y la app
la recoge y la muestra.

## Principios

- **Genérica:** sirve para cualquier proyecto. Nada del código ni de la documentación depende
  de una app concreta.
- **Simple:** un Worker con dos rutas, una para la app y otra para administración, sin login de
  usuario ni servidor que mantener.
- **Sin costo al empezar:** cabe en los planes gratuitos de Cloudflare y FCM.
- **La nube como fuente de verdad:** el Worker guarda el comentario, la respuesta y el histórico. El
  dispositivo solo guarda las llaves para leerlos y una caché.

## Notas

- [Desplegar](DEPLOY.md), [integrar en iOS](INTEGRATION-IOS.md) y [API](API.md): guías públicas, en inglés.
- [Diseño](diseno.md): flujo, API, datos, seguridad y lo que falta comprobar.
- [Publicación](publicacion.md): reglas para que el repo público nunca contenga datos privados.
- [Roadmap](ROADMAP.md): pasos, en orden.

## Dónde estamos

Worker, CLI, SDK y documentación públicos. Falta la integración definitiva en el proyecto piloto y las pruebas para la versión 1.0.0. Ver
[Roadmap](ROADMAP.md).
