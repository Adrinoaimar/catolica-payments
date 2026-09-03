# Guía de activación real

Esta guía separa el software verificable de las credenciales y cuentas que solo puede administrar el propietario de la institución.

## Variables por ambiente

En Vercel Production configure `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PAYMENT_PROVIDER=taypi`, `TAYPI_PUBLIC_KEY`, `TAYPI_SECRET_KEY`, `TAYPI_WEBHOOK_SECRET` y `CRON_SECRET`. Mantenga las claves privadas sin prefijo `VITE_`. Use `TAYPI_SANDBOX=true` y claves de prueba únicamente en un entorno de staging; el verificador las rechaza en producción.

Antes de desplegar, ejecute `npm run verify:production` con las variables cargadas. El comando solo valida presencia, forma, HTTPS y separación de secretos; nunca imprime sus valores. CI también ejecuta esta verificación con valores sintéticos para detectar regresiones, pero no sustituye validarla contra las variables reales del proyecto.

## Migraciones y Realtime

Ejecute en orden todas las migraciones de `supabase/migrations/`, incluidas `20260902000002_realtime_payment_updates.sql`, `20260902000003_admin_cancellation.sql`, `20260902000004_admin_settings.sql`, `20260902000005_webhook_receipts_and_job_lock.sql`, `20260902000006_create_idempotency.sql`, `20260902000007_lock_admin_role_changes.sql`, `20260903000008_harden_webhook_identity.sql`, `20260903000009_recoverable_payment_intents.sql` y `20260903000010_realtime_delete_identity.sql`. Después cree al menos un usuario Auth y su fila `user_roles` con `ADMIN` o `CASHIER`. Verifique que el canal `payment_updates` se suscribe con sesión autenticada y que `provider_data` nunca aparece en el payload público.

## Smoke test antes de dinero real

1. Iniciar sesión como cajero y crear un cobro pequeño.
2. Confirmar que aparece QR/checkout de Taypi y estado `PENDING`.
3. Completar el pago sandbox y comprobar que el webhook cambia a `PAID` una sola vez.
4. Reenviar el mismo webhook y comprobar que no duplica `payment_events`.
5. Bloquear temporalmente el webhook, ejecutar el cron con `Authorization: Bearer $CRON_SECRET` y comprobar reconciliación.
6. Confirmar actualización en otra sesión autenticada y revisar dashboard/operaciones.
7. Probar expiración, `FAILED` y `CANCELLED`; ninguna debe mostrarse como pagada.

## Rollback seguro

Si el smoke test falla, desactive el despliegue o vuelva a un entorno local de desarrollo para usar `PAYMENT_PROVIDER=mock`; los entornos Vercel no deben usar el simulador. No marque operaciones manualmente. Revierta el alias de Vercel al último deployment conocido y conserve la base de datos y `payment_events`. Las migraciones son aditivas; no ejecute `DROP TABLE` ni borre el ledger como rollback. Investigue primero logs sin imprimir secretos o payloads crudos.

## Scheduler

El cron de `vercel.json` usa cada cinco minutos. La ruta declara `maxDuration=300` y limita cada pasada a 12 pendientes con cuatro solicitudes simultáneas. Si el plan Vercel limita esa frecuencia o duración, invoque `/api/cron/reconcile-payments` desde Supabase Cron/`pg_cron` o un scheduler externo con el mismo secreto. El endpoint devuelve `503` si alguna operación no pudo reconciliarse, para que el scheduler/monitorización lo detecte. También recupera intenciones `PENDING` que aún no tienen `provider_payment_id`, usando la misma referencia/idempotencia del proveedor. El webhook firmado sigue siendo la autoridad y el cron solo reconcilia estados consultados server-side.

La migración `20260902000005_webhook_receipts_and_job_lock.sql` registra únicamente proveedor, identificador de entrega, hash SHA-256, resultado y código de error; no duplica el payload crudo. También crea un lease de Postgres para evitar cron solapado. Si el lock no está aplicado, el endpoint devuelve `503` y no consulta al proveedor.

## PWA

La build productiva debe publicar `manifest.webmanifest`, `/icons/icon.svg` y `/sw.js` en la raíz del dominio. Compruebe en DevTools que el worker esté activo y que una navegación sin conexión solo recupere la interfaz, nunca respuestas de `/api/`, webhooks o datos de Supabase. El worker no sustituye la autenticación ni habilita cobros offline: antes de aprobar una operación, el cajero debe tener conectividad con el API y el ledger. Al cambiar la estrategia o los assets no versionados, incremente las versiones de caché en `public/sw.js` y repita el smoke test.
