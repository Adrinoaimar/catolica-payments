# Guía de activación real

La aplicación está preparada para Neon + Firebase + TAYPI, pero las cuentas y credenciales deben ser del propietario de la institución.

## Variables

En Vercel configure las variables de [.env.example](.env.example). En Preview use `PAYMENT_PROVIDER=taypi` con claves `*_test_*`; en Production use `*_live_*` solo tras completar la verificación comercial. Mantenga `DATABASE_URL`, Firebase Admin, `CRON_SECRET` y secretos de webhook sin prefijo `VITE_`.

Ejecute con las variables cargadas:

```bash
npm run verify:production
```

El verificador comprueba presencia, forma, HTTPS y separación de secretos sin imprimir valores.

## Neon y Firebase

Ejecute `npm run db:migrate` con `DATABASE_URL` cargada, o [database/migrations/0001_initial.sql](database/migrations/0001_initial.sql) en Neon. El migrador abre una transacción, aplica la migración y revierte si falla. Cree el primer usuario con Email/Password en Firebase y copie su UID a `user_roles` con rol `ADMIN`. Configure los dominios autorizados de Firebase para localhost y el dominio de Vercel.

## Smoke test

1. Ejecute `node scripts/verify-taypi-sandbox.mjs --network`.
2. Inicie sesión como `CASHIER` y obtenga un ID token temporal; no lo guarde en Git.
3. Ejecute `node scripts/smoke-taypi.mjs` con `APP_BASE_URL`, `FIREBASE_ID_TOKEN` y `TAYPI_SMOKE_CONFIRM=SANDBOX_ONLY`.
4. Confirme que el QR/checkout aparece como `PENDING`.
5. Abra `https://sandbox.taypi.pe/simulator`, escanee el QR y compruebe que el webhook firmado lo cambia una sola vez a `PAID`.
6. Si el webhook tarda, reanude con `SMOKE_REFERENCE` y `SMOKE_WAIT_SECONDS`; el botón de reconciliación consulta TAYPI server-side.
7. Reenvíe el webhook desde el panel TAYPI y verifique que no duplica `payment_events`.
8. Ejecute el cron con `Authorization: Bearer <CRON_SECRET>` y compruebe conciliación.
9. Pruebe expiración, `FAILED`, efectivo, cancelación administrativa, dashboard, permisos y respuestas `429`.

El script finaliza con código `2` si el cobro sigue `PENDING`; eso significa que
falta completar el simulador, no que se haya confirmado un pago. Usa código `0`
solo cuando TAYPI reporta `PAID` (o si se establece `SMOKE_ALLOW_PENDING=true`
para un smoke parcial).

Para funciones locales use `npx vercel@latest dev`; `npm run dev` sirve únicamente la SPA.

## Scheduler y rollback

El cron configurado en `vercel.json` intenta ejecutarse cada cinco minutos. Vercel Hobby puede limitar esta frecuencia; use un scheduler HTTPS externo que envíe `CRON_SECRET` hasta disponer de un plan/host que garantice el intervalo. El lock en Neon impide ejecuciones solapadas.

Ante un fallo, desactive el alias o vuelva al deployment anterior sin borrar tablas ni `payment_events`. Las migraciones son aditivas. Nunca marque operaciones manualmente ni active el mock en Preview/Production.

## Criterio para dinero real

No basta con que la UI compile. Antes de cobrar a una persona real deben estar completos: cuenta TAYPI verificada, claves live, webhook HTTPS, `DATABASE_URL` de producción, usuario administrador, backup/exportación de Neon, prueba de conciliación y una operación controlada de importe pequeño. TAYPI puede aplicar comisiones aun cuando la infraestructura gratuita permanezca dentro de sus cuotas.

El sandbox no procesa dinero ni acepta QR desde Yape/Plin reales. El paso de
dinero real requiere cambiar a `app.taypi.pe`, claves `*_live_*`, KYB y una
prueba controlada; no se habilita desde el smoke sandbox.
