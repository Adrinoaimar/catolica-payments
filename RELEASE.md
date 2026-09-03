# Guía de activación real

Esta guía separa el software verificable de las credenciales y cuentas que solo puede administrar el propietario de la institución.

## Variables por ambiente

En Vercel Production configure `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PAYMENT_PROVIDER=taypi`, `TAYPI_PUBLIC_KEY`, `TAYPI_SECRET_KEY`, `TAYPI_WEBHOOK_SECRET` y `CRON_SECRET`. Mantenga las claves privadas sin prefijo `VITE_`. Use `TAYPI_SANDBOX=true` y claves de prueba únicamente en un entorno de staging; el verificador las rechaza en producción.

Antes de desplegar, ejecute `npm run verify:production` con las variables cargadas. El comando solo valida presencia, forma, HTTPS y separación de secretos; nunca imprime sus valores.

## Migraciones y Realtime

Ejecute en orden todas las migraciones de `supabase/migrations/`, incluidas `20260902000002_realtime_payment_updates.sql` y `20260902000003_admin_cancellation.sql`. Después cree al menos un usuario Auth y su fila `user_roles` con `ADMIN` o `CASHIER`. Verifique que el canal `payment_updates` se suscribe con sesión autenticada y que `provider_data` nunca aparece en el payload público.

## Smoke test antes de dinero real

1. Iniciar sesión como cajero y crear un cobro pequeño.
2. Confirmar que aparece QR/checkout de Taypi y estado `PENDING`.
3. Completar el pago sandbox y comprobar que el webhook cambia a `PAID` una sola vez.
4. Reenviar el mismo webhook y comprobar que no duplica `payment_events`.
5. Bloquear temporalmente el webhook, ejecutar el cron con `Authorization: Bearer $CRON_SECRET` y comprobar reconciliación.
6. Confirmar actualización en otra sesión autenticada y revisar dashboard/operaciones.
7. Probar expiración, `FAILED` y `CANCELLED`; ninguna debe mostrarse como pagada.

## Rollback seguro

Si el smoke test falla, cambie `PAYMENT_PROVIDER` a `mock` solo en Preview o desactive el despliegue; no marque operaciones manualmente. Revierta el alias de Vercel al último deployment conocido y conserve la base de datos y `payment_events`. Las migraciones son aditivas; no ejecute `DROP TABLE` ni borre el ledger como rollback. Investigue primero logs sin imprimir secretos o payloads crudos.

## Scheduler

El cron de `vercel.json` usa cada cinco minutos. Si el plan Vercel limita esa frecuencia, invoque `/api/cron/reconcile-payments` desde Supabase Cron/`pg_cron` o un scheduler externo con el mismo secreto. El webhook firmado sigue siendo la autoridad y el cron solo reconcilia estados consultados server-side.
