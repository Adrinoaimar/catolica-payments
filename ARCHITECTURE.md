# Arquitectura

## Principios

1. El backend es la única autoridad financiera.
2. Cada intento tiene `reference`, `provider_payment_id` e idempotencia.
3. El dominio depende de `PaymentProvider`, no de la empresa que procesa el pago.
4. Cada transición deja una fila de auditoría.
5. El dinero se representa como enteros en centavos (`PEN`).

## Capas

```text
React/Vite
  ↓ Bearer Firebase ID token
Vercel Functions (validación, RBAC, webhook)
  ↓ server-only DATABASE_URL
Neon PostgreSQL (ledger SQL, constraints, funciones atómicas)
  ↘ TAYPI / Mock PaymentProvider
```

Firebase Authentication solo gestiona identidad. Neon conserva `user_roles`, por lo que una interfaz manipulada no puede elevar privilegios con metadata del navegador.

## Flujo digital

```text
CASHIER → POST /api/payments
  → persistir intención PENDING
  → crear checkout TAYPI y adjuntar ID externo
  → mostrar QR
  → webhook firmado del proveedor
  → validar identidad, importe, moneda e idempotencia
  → función SQL bloquea la fila y escribe payment_events
  → PENDING pasa a PAID/FAILED/EXPIRED/CANCELLED
  → UI consulta el ledger con polling mientras siga pendiente
```

Una respuesta del navegador, un contador o un QR nunca cambia el estado financiero. Una captura TAYPI tardía puede pasar `EXPIRED → PAID` si el proveedor la confirma y los importes coinciden.

## Modelo de datos

La migración [database/migrations/0001_initial.sql](database/migrations/0001_initial.sql) crea `payments`, `payment_events`, `user_roles`, `quick_amounts`, `webhook_receipts`, `job_locks` y `api_rate_limits`. Las claves externas del ledger y los índices de referencia, estado, proveedor y fecha protegen consultas y reintentos. Los UID de Firebase se almacenan como `text`.

Las funciones `apply_payment_webhook`, `record_cash_payment`, `attach_payment_provider`, `expire_payment`, `cancel_payment`, `admin_set_user_role`, `acquire_job_lock` y `consume_api_rate_limit` ejecutan las mutaciones en Neon. No se expone una credencial de base de datos al navegador.

## Roles

- `CASHIER`: crear cobros digitales/efectivo y consultar operaciones del día calendario de Lima.
- `ADMIN`: todo lo anterior, reportes globales, montos rápidos, usuarios y cancelaciones pendientes.
- Ningún cliente puede escribir `PAID`, cambiar auditoría o leer secretos.

El backend verifica el ID token con Firebase Admin y luego obtiene el rol desde `user_roles`. La creación del primer administrador es una operación manual documentada en README; después los cambios pasan por la función SQL serializada.

## Webhooks y conciliación

Un webhook es un POST HTTPS del proveedor al endpoint `/api/webhooks/<provider>`. El endpoint conserva solo el hash/resultado de entrega en `webhook_receipts`; el payload financiero auditado queda en `payment_events`. La firma HMAC y el timestamp se validan antes de cualquier transición.

`/api/cron/reconcile-payments` consulta TAYPI server-side como respaldo. Usa `job_locks` y límites distribuidos en Neon. Vercel Hobby no garantiza cron cada cinco minutos; en ese plan se usa un scheduler externo o invocación manual hasta contar con un entorno operativo adecuado.

## QR y billeteras

TAYPI devuelve el QR dinámico interoperable. Yape y Plin pueden escanearlo; Lemon es una billetera de cliente, no un proveedor de backend en esta aplicación. Un número telefónico por sí solo no produce un QR dinámico ni una confirmación verificable.

## Despliegue

Vercel compila la SPA y sirve las funciones. Variables `VITE_FIREBASE_*` son públicas y restringidas por dominio; `DATABASE_URL`, Firebase Admin, TAYPI y `CRON_SECRET` son secretas. Preview se usa para sandbox. Production requiere cuenta TAYPI verificada, webhook HTTPS, logs sin secretos y una operación controlada.
