# Catolica Payments

Sistema de caja web para Grupo La Católica (Perú). Permite generar cobros por QR, esperar confirmación financiera verificada por webhook y registrar pagos en efectivo. Está diseñado para cobros rápidos en celular, tablet y PC.

## Qué resuelve

El cajero selecciona un monto, genera una operación única y muestra el QR al cliente. La operación queda `PENDING` hasta que el backend recibe y valida el webhook del proveedor. Solo entonces pasa a `PAID` y el dashboard se actualiza. El modo `mock` reproduce ese flujo sin dinero ni credenciales reales.

Nunca se marca un pago como exitoso por una señal del frontend. Nunca se usa monto flotante: `S/30.50` se guarda como `3050` centavos.

## Stack y arquitectura

- Frontend: React, Vite, TypeScript y Tailwind CSS.
- Backend: Node.js/TypeScript en funciones serverless.
- Persistencia y autenticación: Supabase (PostgreSQL, Auth y Realtime).
- Despliegue: Vercel conectado a GitHub.
- Proveedores: `MockPaymentProvider` y `TaypiProvider` están disponibles; las clases genéricas para Culqi/Mercado Pago quedan reservadas hasta completar sus contratos específicos.

Detalles de flujos, estados, rutas y límites: [ARCHITECTURE.md](ARCHITECTURE.md). Controles de seguridad: [SECURITY.md](SECURITY.md). Trabajo por fases: [PLAN.md](PLAN.md).

## Requisitos

- Node.js 20 LTS o superior.
- npm 10 o superior.
- Proyecto Supabase para persistencia y autenticación. El modo mock no requiere cuenta de pagos.

## Instalación local

```bash
npm install
copy .env.example .env.local
```

En macOS/Linux, use `cp .env.example .env.local`. Complete `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY` para el navegador, además de `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` para las funciones serverless; no confirme secretos en Git.

La sesión del navegador usa Supabase Auth (Email/Password), persiste mediante el cliente oficial y envía `Authorization: Bearer <access_token>` a cada endpoint protegido. Cada usuario debe tener una fila en `public.user_roles` con rol `ADMIN` o `CASHIER`; el frontend no acepta el rol desde metadata para autorizar operaciones. Las rutas mock se bloquean tanto en Production como en Preview de Vercel, aunque alguien configure `PAYMENT_PROVIDER=mock` por error.

Ejecute las migraciones de `supabase/migrations/` en el proyecto Supabase. Después inicie el entorno:

```bash
npm run dev
```

Scripts esperados:

```bash
npm run test
npm run build
```

Cada push o pull request ejecuta automáticamente tests, build, auditoría de dependencias y una verificación sintética de la forma del entorno productivo mediante GitHub Actions (`.github/workflows/ci.yml`). La verificación no contiene ni imprime secretos reales.

## Variables de entorno

Consulte [.env.example](.env.example). `PAYMENT_PROVIDER=mock` es la configuración segura para desarrollo. `VITE_DEMO_MODE=true` habilita explícitamente el flujo offline local y solo tiene efecto en builds no productivos; sin esa bandera, la app falla cerrado si Supabase no está configurado y nunca crea sesiones falsas ni recupera pagos desde `localStorage`. `CRON_SECRET` protege la reconciliación programada. Las claves `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET` y de proveedores solo deben existir en el backend/serverless; nunca deben exponerse como variables `VITE_*` ni enviarse al navegador.

## Probar el flujo mock

1. Inicie sesión con un usuario de rol `CASHIER`.
2. Seleccione `S/10`, `S/20`, `S/30`, `S/40`, `S/50` u otro monto.
3. Elija **Pago digital** y genere el cobro.
4. Abra `/dev/mock-payment/<reference>` en otra pestaña o use el enlace del QR.
5. Pulse **Simular pago exitoso**.
6. El simulador llama `POST /api/webhooks/mock`; no actualiza la base de datos directamente.
7. Verifique `PAID`, el mensaje `PAGO RECIBIDO` y el registro en el dashboard.

La ruta `/dev/mock-payment/:reference` solo se habilita en desarrollo local. Queda bloqueada en Vercel Preview y Production; el mock no representa una integración real con Yape o Plin.

Para efectivo, seleccione el monto, **Efectivo** y confirme. Se crea una operación `PAID` con `provider=CASH` y el usuario autenticado como registrador.

### Administración

Los usuarios con rol `ADMIN` tienen una pantalla de administración para invitar usuarios, cambiar roles (sin poder quitarse el último administrador) y reemplazar los montos rápidos. Estas acciones usan `Supabase Auth` y funciones SQL protegidas; los cajeros solo leen los montos activos mediante `GET /api/quick-amounts`.

## Estados y webhooks

Las operaciones digitales siguen `PENDING -> PAID`, o `PENDING -> EXPIRED`, `FAILED` o `CANCELLED` según resultado. Los endpoints públicos son:

```text
POST /api/webhooks/mock
POST /api/webhooks/taypi
POST /api/webhooks/mercadopago (reservado; adaptador específico pendiente)
POST /api/webhooks/culqi (reservado; adaptador específico pendiente)
```

Cada adaptador debe autenticar el evento, buscar la referencia, comparar monto y moneda, validar `provider_payment_id`, rechazar duplicados de forma idempotente y registrar `payment_events` dentro de una operación atómica. Responda rápido con HTTP 200 solo después de aceptar el evento; eventos inválidos deben rechazarse con el código apropiado sin modificar pagos. `webhook_receipts` conserva el identificador de entrega, hash del body, resultado y código de error para observabilidad sin duplicar payloads sensibles.

Un administrador puede cancelar una operación digital `PENDING` desde la pantalla de cobro. La API `POST /api/payments/:reference/cancel` exige sesión Bearer con rol `ADMIN`, consulta el estado del proveedor antes de cancelar y registra la transición y su motivo en `payment_events` dentro de una operación atómica. Nunca puede convertir una operación terminal en `CANCELLED`.

Las creaciones aceptan `Idempotency-Key` (16–200 caracteres imprimibles); la API la exige para cobros digitales. La clave queda registrada con el pago y una repetición compatible devuelve el mismo checkout o recibo de efectivo; reutilizarla con otro monto, usuario o método devuelve `409`. La intención `PENDING` se guarda antes de llamar al proveedor y un reconciliador puede completar un checkout cuyo ID no alcanzó a persistirse.

### Alternativa cuando el webhook se retrasa

El webhook del proveedor es el camino principal. Como respaldo, `GET /api/cron/reconcile-payments` consulta server-side el estado de cada operación `PENDING` mediante `getPayment`, vuelve a validar proveedor, referencia, monto, moneda y estado, y usa la misma transición RPC idempotente. La pantalla abierta también puede llamar `POST /api/payments/:reference/reconcile` como acción operativa excepcional, pero no consulta al proveedor cada pocos segundos: solo lee el ledger autorizado. Ninguna ruta acepta una confirmación desde el navegador. El cron se protege con `Authorization: Bearer <CRON_SECRET>` y `vercel.json` lo programa cada cinco minutos; en Vercel Hobby esa frecuencia no está disponible, por lo que debe invocarse desde Supabase Cron/`pg_cron` o un scheduler externo con `CRON_SECRET`. Vercel documenta que el secreto se entrega en el header de la invocación y que Hobby limita la frecuencia a una vez al día. [Vercel Cron](https://vercel.com/docs/cron-jobs/manage-cron-jobs)

TAYPI también reintenta webhooks y permite reenvío manual desde su panel. La reconciliación por `GET /api/v1/payments/:payment_id` es una red de seguridad, no reemplaza la firma HMAC ni la auditoría. [SDK JavaScript de TAYPI](https://docs.taypi.pe/sdks/javascript), [Webhooks de TAYPI](https://docs.taypi.pe/webhooks)

Alternativas evaluadas: reenvío/reintentos nativos de TAYPI, polling server-side centralizado (implementado mediante cron y acción excepcional), Supabase Cron/`pg_cron` llamando esta ruta, y Supabase Queues para una futura cola durable. El cliente TAYPI reintenta solo fallos transitorios HTTP (429/5xx/timeouts), con backoff acotado e idempotency keys. Cada pasada del reconciliador inspecciona como máximo 12 pendientes y consulta hasta cuatro en paralelo; un lease en Postgres evita ejecuciones solapadas. La ruta declara un presupuesto de hasta cinco minutos para despliegues Vercel compatibles; la plantilla Supabase usa un timeout HTTP de cuatro minutos. Supabase Realtime es el canal principal para refrescar la interfaz; la app solo usa lectura del ledger como respaldo cuando el canal no está saludable. `onSuccess` de un checkout o cualquier señal del navegador no confirma dinero. Referencias: [Supabase Cron](https://supabase.com/docs/guides/cron), [Supabase Queues](https://supabase.com/docs/guides/queues).

Para usar Supabase Cron como alternativa a Vercel Cron, habilite `pg_cron` y `pg_net`, guarde la URL HTTPS del endpoint y `CRON_SECRET` en Supabase Vault, y ejecute la plantilla [supabase/cron/reconcile-payments.sql.example](supabase/cron/reconcile-payments.sql.example) con el rol `postgres`. La plantilla no contiene secretos, usa `Authorization: Bearer` y permite revisar ejecuciones en `cron.job_run_details` y respuestas en `net._http_response`. Mantenga un solo job activo para evitar llamadas duplicadas; el lock transaccional del endpoint también protege contra solapamientos.

## Activar Taypi

La integración operativa actual es `TaypiProvider` y usa la API REST oficial de TAYPI. Configure las claves en el entorno serverless (nunca en `VITE_*`) y cambie:

```text
PAYMENT_PROVIDER=taypi
```

Variables requeridas:

```text
TAYPI_PUBLIC_KEY=taypi_pk_live_...
TAYPI_SECRET_KEY=taypi_sk_live_...
TAYPI_WEBHOOK_SECRET=...
TAYPI_API_URL=https://app.taypi.pe
```

Para sandbox use claves `taypi_pk_test_*`/`taypi_sk_test_*`, `TAYPI_SANDBOX=true` y `TAYPI_API_URL=https://sandbox.taypi.pe`. Si `TAYPI_API_URL` queda vacío, el adaptador selecciona sandbox para una public key `*_test_*` y producción para una public key `*_live_*`. Culqi y Mercado Pago permanecen reservados hasta implementar y probar sus contratos específicos; seleccionar uno falla cerrado.

El adaptador llama `POST /api/v1/payments` con monto decimal (por ejemplo, `"30.50"`), `currency: "PEN"` y la referencia como `Idempotency-Key`. Firma cada request con HMAC-SHA256 sobre `{timestamp}\n{method}\n{path}\n{body}`, envía `Authorization: Bearer <TAYPI_PUBLIC_KEY>` y conserva el `payment_id`, `qr_image`, `checkout_url` y `expires_at` devueltos por TAYPI. Las consultas usan `GET /api/v1/payments/:payment_id`; las cancelaciones, `POST /api/v1/payments/:payment_id/cancel`.

Configure en el panel de TAYPI el webhook `https://<dominio-produccion>/api/webhooks/taypi`. El endpoint conserva el body crudo, valida `Taypi-Signature` (`sha256=<hex>`) con `TAYPI_WEBHOOK_SECRET`, exige `Taypi-Timestamp` fresco (tolerancia predeterminada de 10 minutos y 60 segundos de desfase futuro), compara referencia, monto y moneda en el servicio de pagos, y acepta `payment.completed`, `payment.expired`, `payment.cancelled`, `payment.failed` y `payment.rejected`. Los webhooks no se consideran confirmación hasta superar todas esas validaciones.

Antes de procesar dinero real, complete la verificación KYB de la cuenta de TAYPI, registre el webhook HTTPS de producción y ejecute un pago real de extremo a extremo. Las claves de sandbox no procesan dinero real ni funcionan en `app.taypi.pe`.

## Supabase

1. Cree un proyecto y habilite Email/Password o el proveedor de Auth seleccionado.
2. Ejecute en orden las migraciones en `supabase/migrations/`, incluidas `20260903000008_harden_webhook_identity.sql` para instalaciones que ya tenían la función RPC anterior, `20260903000009_recoverable_payment_intents.sql` para adjuntar de forma transaccional el checkout externo a una intención pendiente y `20260903000010_realtime_delete_identity.sql` para que los eventos de eliminación sean recuperables en Realtime.
3. Asigne roles mediante el mecanismo definido por las migraciones (`ADMIN` o `CASHIER`).
4. Ejecute también `20260902000002_realtime_payment_updates.sql`; crea la proyección mínima `payment_updates`, su trigger y la publicación `supabase_realtime` sin transmitir `provider_data`.
5. Verifique RLS con ambos roles antes de publicar.

El navegador usa únicamente la URL y anon key. La service-role key se reserva para funciones serverless y tareas administrativas.

## Despliegue en Vercel

Para la activación y el smoke test de producción, siga [RELEASE.md](RELEASE.md); separa las comprobaciones del código de las credenciales y cuentas externas.

1. Suba el repositorio a GitHub.
2. En Vercel, importe el repositorio y seleccione el framework detectado por el proyecto.
3. Configure las variables de entorno por ambiente (Preview y Production).
4. Mantenga `PAYMENT_PROVIDER=mock` y `VITE_DEMO_MODE=true` solo en un entorno local de desarrollo; los builds de Vercel nunca deben usar el simulador.
5. Configure las URLs de webhook del proveedor hacia el dominio de producción.
6. Configure `CRON_SECRET` y confirme que el cron de reconciliación tiene permiso para consultar el proveedor.
7. Proteja Production con claves reales solo después de revisar logs y pruebas.

Cada push a `main` puede generar el despliegue de producción mediante la integración oficial GitHub-Vercel. No use GitHub Pages para secretos, funciones serverless o webhooks.

### PWA y caché

La build de producción incluye `manifest.webmanifest`, el icono institucional y `sw.js`. El navegador registra el service worker únicamente cuando `import.meta.env.PROD` es verdadero. El worker usa una caché limitada al shell (`/`, `index.html`, `/assets/`, `/icons/` y el manifest): las navegaciones usan red primero y solo muestran el shell guardado si no hay conexión.

No se interceptan métodos distintos de `GET`, rutas `/api/`, webhooks, `/dev/`, rutas de Supabase ni solicitudes cross-origin. Por ello, el modo offline nunca confirma pagos ni muestra una confirmación financiera guardada; las operaciones siempre dependen del API autenticado y del ledger server-side. Cuando se publica una nueva build, los assets versionados por Vite evitan colisiones; si cambia el worker o algún asset no versionado, se deben incrementar sus nombres de caché para que la activación elimine la versión anterior.

## GitHub

```bash
git init
git add .
git commit -m "feat: initial catolica payments MVP"
git branch -M main
git remote add origin https://github.com/<organizacion>/catolica-payments.git
git push -u origin main
```

Antes de `git add`, revise `git diff --cached`, archivos `.env*`, logs y artefactos. El `.gitignore` excluye secretos y salidas generadas.

## Limitaciones explícitas

El proyecto no almacena claves bancarias, contraseñas, PIN, OTP ni credenciales financieras del cliente. No intenta ingeniería inversa, scraping o interceptación de Yape. Proveedores reales pueden cobrar comisión; el modo mock es únicamente para desarrollo y demostración a costo S/0.
