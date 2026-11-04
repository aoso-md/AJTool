# Inteligencia de calidad AJTool — MVP local privado

Lee `../docs/RELEASE-20261103.md` y `UX-CONTRACT.md` antes de usar. Las definiciones de datos están en `src/queries.mjs`, `src/quality.mjs` y `sql/views.sql`.
No es un despliegue oficial, no usa datos industriales reales ni entrena modelos.
La aplicación rechaza destinos remotos y exige ANALYTICS_MODE=local-synthetic.

1. Reutilizar el staging existente de `deploy/product-polish/compose.yml`.
2. `python analytics/deploy/prepare.py`: verifica los IDs sintéticos conocidos y
   crea vistas y un rol real SELECT-only en las bases existentes. No crea otra base,
   no copia estudios y no rota un rol previo. El directorio privado está ignorado.
3. `docker compose -f analytics/deploy/compose.yml up --build -d`.
4. Abrir localmente la URL de `.env.quality-intelligence/access.json`. No pegarla
   en chats o informes: contiene una capacidad efímera de lectura, no un login admin.
   La URL se limpia del fragmento al canjearse; una sesión previa puede usar
   `http://127.0.0.1:30110/`. La capacidad vence en cinco minutos y se consume una vez.
5. Usar Cerrar acceso para revocar la sesión. Para una nueva sesión después de cerrar
   o caducar, reiniciar sólo el contenedor dashboard, que genera otra capacidad.
   No reiniciar las tools ni PostgreSQL para recuperar acceso al dashboard.

Tests: `node --test analytics/test/unit.test.mjs` desde la raíz (dependencias del
paquete instaladas); `docker compose -f analytics/deploy/compose.yml exec -T dashboard
node test/pg-staging.mjs` para comprobaciones de lectura real. No ejecutar scripts
de preparación contra producción. El contenedor limita capacidades y filesystem;
sólo escribe auditoría minimizada y acceso efímero en el directorio privado.

Es una aplicación del repo AJTool con su backend de consultas, no un informe público
estático o una publicación Sites. Ese destino y el diseño existente prevalecen
sobre plantillas genéricas de dashboard. No se crearon servicios externos.
