# Entrega AJTool para Carlos — 27/10/2026

Esta carpeta es la configuración vigente para la entrega solicitada. El modo abierto es intencional: `OIDC_ISSUER` vacío y `TOOL_API_KEY` vacía permiten usar las tools sin iniciar sesión. Keycloak y la demo privada anterior no son requisitos.

## Callbacks confirmados por el mensaje de Carlos

- CPK/PPK: `https://ccp.orcalabs.mx/auth/callback`
- MSA: `https://rma.orcalabs.mx/auth/callback`

Son URLs de retorno, no issuers. `idp.orcalabs.mx` se descarta como referencia: no se solicita crearlo ni reparar su DNS. Sin issuer, las rutas OIDC no se activan y no es necesario un login para la aceptación actual.

## Construcción

Requisitos: Docker con contenedores Linux. Para desarrollo y pruebas, Node 22 y el pnpm fijado en cada `package.json` (`11.7.0`). Las imágenes existentes incluyen UI y API.

```powershell
docker build -f docker/calculate_cpk_ppk.Dockerfile -t ajtool-cpk-carlos:20261027 .
docker build -f docker/run_msa_analysis.Dockerfile -t ajtool-msa-carlos:20261027 .
```

## Demostración local sin login ni ORCA

Desde la raíz del paquete, ejecutar una sola vez `node deploy/carlos/prepare-local.mjs`. En Windows, restringir la carpeta privada recién generada al usuario actual y SYSTEM:

```powershell
node deploy/carlos/prepare-local.mjs
$demoUser=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name
icacls .env.carlos-local /inheritance:r /grant:r "${demoUser}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F'
docker compose -f deploy/carlos/local-compose.yml up -d --build
node deploy/carlos/check-local.mjs create
```

Abrir `http://127.0.0.1:29108` y `http://127.0.0.1:29109`. El HTTP sólo sirve para esta demo enlazada a localhost; en hosting se requiere HTTPS. No se requieren usuario, contraseña, issuer, cliente OIDC ni claves ORCA. Los ejemplos fijan shadow y polling deshabilitado. Cada tool tiene su propia base y rol runtime; el volumen local conserva los datos.

El generador se niega a sobrescribir credenciales. Para volver a arrancar, reutilizar carpeta y volumen. No ejecutar `down -v`, borrar `.env.carlos-local` ni limpiar volúmenes.

Para ensayar persistencia, sólo en este proyecto LOCAL nuevo:

```powershell
docker compose -f deploy/carlos/local-compose.yml restart cpk msa
node deploy/carlos/check-local.mjs recover
```

No trasladar este comando de reinicio a instancias previas o productivas.

## Configuración de hosting, pendiente de aplicación por su operador

Usar `cpk.env.example` y `msa.env.example` como especificación, no como archivo secreto. Provisionar `DATABASE_URL` en el almacén del entorno con un rol runtime restringido y base exclusiva por tool. Las plantillas están marcadas `AJTOOL_ENVIRONMENT=staging`; una transición productiva es una operación separada, posterior al respaldo de cualquier RAM.

Aplicar `db/migrate.sql` y después `db/runtime-role.sql` con el rol migrador/owner, fuera del runtime. No entregar credenciales owner/admin a las apps. Mantener `DATABASE_REQUIRED=true`: sin base válida el arranque falla explícitamente; no hay degradación silenciosa a memoria.

No definir `TOOL_API_KEY` en la configuración abierta de navegador: habilitar sólo el plano máquina sin issuer impediría el acceso humano. La conexión al Core y el modo live quedan deshabilitados en esta entrega de demostración; su activación requiere el contrato y autorización de integración correspondientes.

Cuando exista un issuer oficial y se decida activar SSO, configurar el issuer, cliente, secreto y sesión en su almacén, conservar `openid` y los callbacks exactos, y verificar roles y logout. No usar el proveedor local de la demo privada como identidad productiva.

## Aceptación actual

- UI y API accesibles sin login, `/auth/me` informa `mode:open`, `authenticated:false`.
- `/ready` 200 con PostgreSQL, shadow y polling deshabilitado.
- Crear y consultar CPK de 25 observaciones individuales y MSA 3×10×3 con fixtures sintéticas.
- Resultados coinciden con las referencias; mismos estudios y outbox tras reinicio de procesos de prueba.
- Base ausente/incompatible causa fallo explícito, no RAM; suite PostgreSQL comprueba permisos, rollback y recuperación.
- Sin secretos, datos reales, dependencias instaladas ni configuración privada en el paquete.

En modo abierto no hay identidad humana verificada ni control de roles por usuario; esto es el comportamiento pedido por Carlos y no se presenta como autenticación fuerte. La demostración local limita acceso a localhost. La exposición remota y sus controles de red corresponden al operador autorizado.

No se ha desplegado, reiniciado ni cambiado ninguna instancia externa. Antes de alterar servicios que declaren memoria: inventario autorizado por réplica, exportación completa sin reinicio y recuperación verificada. Las listas API limitadas no bastan para demostrar respaldo de RAM.
