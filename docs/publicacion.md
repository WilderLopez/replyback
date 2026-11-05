---
tags: [publicacion]
estado: vigente
---

# Publicación

Volver a [Inicio](Inicio.md).

replyback será público, pero se prueba con datos reales de un proyecto privado. Estas reglas
evitan que esos datos terminen en el repo.

## Qué nunca entra al repo

Ni en el código, ni en la documentación, ni en los tests, ni en el historial de git:

- Nombres de proyectos privados, dominios, bundle IDs u organizaciones de Sentry.
- DSN, tokens, claves, cuentas de servicio o IDs de bases de datos y cuentas.
- Comentarios de usuarios, correos, IDs de usuario o tokens FCM.
- Capturas, logs o volcados de pruebas reales.

Estas notas siguen las mismas reglas, porque está previsto que pasen a `docs/` dentro del repo.

## Cómo se separa

| Va en el repo público | Se queda fuera |
|---|---|
| Código del Worker, de la CLI y del SDK | `wrangler.jsonc` real de cada despliegue |
| `wrangler.example.jsonc` y `.env.example` | `.env` y secretos |
| Tests con datos inventados | Datos de prueba reales, en una carpeta local excluida de git |
| Documentación genérica | Integración y configuración de cada proyecto, en el repo de ese proyecto |

## Antes de cada push

1. Pasar un escáner de secretos por **todo el historial**, por ejemplo `gitleaks`.
2. Buscar en todo el historial los nombres e IDs de los proyectos privados, con una lista de
   términos guardada fuera del repo.
3. Revisar qué ficheros nuevos entran.

Borrar algo en un commit posterior no lo elimina del historial. Si se filtra un secreto, se
revoca primero y después se limpia el historial.
