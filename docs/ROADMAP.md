---
tags: [roadmap]
estado: vigente
---

# Roadmap

Volver a [Inicio](Inicio.md).

## 1. Idea

- [x] Documentar el diseño.
- [ ] Confirmar el nombre.
- [x] Resolver lo que se pueda de la lista [Por comprobar](diseno.md#por-comprobar) con comentarios
      reales en Sentry.

## 2. Repo

- [x] Crear la carpeta del proyecto, fuera de cualquier repo privado.
- [x] Mover estas notas a `docs/` y enlazarlas en la bóveda.
- [x] Escribir `CLAUDE.md`.
- [x] Iniciar git con `.gitignore` y ficheros de ejemplo.
- [x] Pasar el escáner de secretos antes del primer push.

## 3. Worker y CLI

- [x] Worker con `/v1/sync` y `/v1/admin/replies`, y base D1, probado con tests.
- [x] Envío de push por FCM, probado contra un FCM simulado.
- [x] Limpieza con Cron Trigger.
- [x] Desplegar y enviar un push real a un dispositivo propio.
- [x] CLI con `list`, `show`, `reply` y `forget`, incluida la derivación del `ref` antiguo, probada con tests.
- [x] Probar la lectura de la CLI contra Sentry y el Worker reales.
- [ ] Pruebas de extremo a extremo con un dispositivo real.

## 4. SDK de iOS

- [x] Paquete Swift con generación de `ref`, sincronización, consulta de comentarios antiguos y almacenamiento local.
- [ ] Integración en el proyecto piloto, dentro de su propio repo.
- [ ] Validación con un comentario real, de principio a fin.
- [ ] Respuestas a los comentarios antiguos del piloto, aprobadas una a una, antes de publicar esa versión.

## 5. Publicación

- [x] Revisión completa según [Publicación](publicacion.md).
- [x] README con instalación y despliegue.
- [x] Subir el repo a GitHub.

## Más adelante

- [ ] Backoffice que use el mismo endpoint de administración.
- [ ] SDK de Android.
