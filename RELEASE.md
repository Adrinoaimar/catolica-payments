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

Ejecute [database/migrations/0001_initial.sql](database/migrations/0001_initial.sql) en Neon. Cree el primer usuario con Email/Password en Firebase y copie su UID a `user_roles` con rol `ADMIN`. Configure los dominios autorizados de Firebase para localhost y el dominio de Vercel.

## Smoke test

1. Inicie sesión como `CASHIER` y cree un cobro sandbox.
2. Confirme que el QR/checkout aparece como `PENDING`.
3. Complete el pago de prueba y compruebe que el webhook firmado lo cambia una sola vez a `PAID`.
4. Reenvíe el webhook y verifique que no duplica `payment_events`.
5. Ejecute el cron con `Authorization: Bearer <CRON_SECRET>` y compruebe conciliación.
6. Pruebe expiración, `FAILED`, efectivo y cancelación administrativa.
7. Revise dashboard, permisos y respuestas `429` de rate limit.

Para funciones locales use `npx vercel@latest dev`; `npm run dev` sirve únicamente la SPA.

## Scheduler y rollback

El cron configurado en `vercel.json` intenta ejecutarse cada cinco minutos. Vercel Hobby puede limitar esta frecuencia; use un scheduler HTTPS externo que envíe `CRON_SECRET` hasta disponer de un plan/host que garantice el intervalo. El lock en Neon impide ejecuciones solapadas.

Ante un fallo, desactive el alias o vuelva al deployment anterior sin borrar tablas ni `payment_events`. Las migraciones son aditivas. Nunca marque operaciones manualmente ni active el mock en Preview/Production.

## Criterio para dinero real

No basta con que la UI compile. Antes de cobrar a una persona real deben estar completos: cuenta TAYPI verificada, claves live, webhook HTTPS, `DATABASE_URL` de producción, usuario administrador, backup/exportación de Neon, prueba de conciliación y una operación controlada de importe pequeño. TAYPI puede aplicar comisiones aun cuando la infraestructura gratuita permanezca dentro de sus cuotas.
