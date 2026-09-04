# Catolica Payments

Caja web para Grupo La Católica (Perú): cobros por QR interoperable, pagos en efectivo, auditoría e informes. El navegador nunca confirma un pago; la autoridad es el backend y el ledger PostgreSQL.

## Decisión técnica gratuita

- React/Vite/TypeScript para la interfaz.
- **Neon PostgreSQL Free** para el ledger, restricciones, transacciones y migraciones.
- **Firebase Authentication Spark** para Email/Password e identidad. Los roles `ADMIN` y `CASHIER` viven en `user_roles` de Neon y se verifican en cada API.
- Vercel Functions para API/webhooks y polling HTTP de cinco segundos mientras una operación está pendiente.
- `MockPaymentProvider` solo en local; `TaypiProvider` para QR y confirmación real.

Neon y Firebase tienen niveles sin tarjeta para pruebas, pero sus cuotas son finitas. TAYPI es un servicio externo: sus credenciales, verificación comercial y comisión no forman parte del coste de esta aplicación.

Detalles de estados y seguridad: [ARCHITECTURE.md](ARCHITECTURE.md), [SECURITY.md](SECURITY.md), [PLAN.md](PLAN.md).

## Requisitos e instalación

- Node.js 20 LTS o superior.
- npm 10 o superior.
- Un proyecto Neon y un proyecto Firebase con Email/Password habilitado.

```bash
npm install
copy .env.example .env.local
npm run dev
```

Para ejecutar también las funciones `api/` localmente:

```bash
npx vercel@latest dev
```

Aplica [database/migrations/0001_initial.sql](database/migrations/0001_initial.sql) una sola vez en el SQL Editor de Neon. Luego crea el primer usuario en Firebase y añade manualmente su rol inicial:

```sql
insert into public.user_roles (user_id, role) values ('UID_FIREBASE', 'ADMIN');
```

Las variables públicas `VITE_FIREBASE_*` solo identifican la aplicación web. `DATABASE_URL`, `FIREBASE_PRIVATE_KEY`, `FIREBASE_CLIENT_EMAIL`, `CRON_SECRET` y las claves de TAYPI son exclusivamente server-side.

## Pruebas

```bash
npm test
npm run typecheck
npm run build
```

El flujo mock local es útil para verificar idempotencia, expiración y auditoría sin dinero:

1. Activa `PAYMENT_PROVIDER=mock` y `VITE_DEMO_MODE=true` solo en desarrollo.
2. Inicia sesión con un usuario de prueba.
3. Genera un cobro y abre `/dev/mock-payment/<reference>`.
4. Simula el pago; la ruta llama al mismo webhook y transición que un proveedor real.

Las rutas `/dev/*` están bloqueadas en Preview y Production.

## TAYPI, Yape y Lemon

El QR dinámico lo entrega TAYPI. Su QR interoperable puede pagarse desde Yape, Plin y billeteras compatibles. Lemon actúa como billetera del cliente que escanea el QR; no es un segundo proveedor de cobro ni aporta un webhook independiente en esta integración.

No se fabrica un QR dinámico a partir de un número telefónico: un QR estático de teléfono no permite confirmar automáticamente el pago. El número receptor se configura en la cuenta comercial verificada del proveedor. Cambiarlo exige repetir una prueba completa de creación, webhook y conciliación.

Activa sandbox:

```text
PAYMENT_PROVIDER=taypi
TAYPI_PUBLIC_KEY=taypi_pk_test_...
TAYPI_SECRET_KEY=taypi_sk_test_...
TAYPI_WEBHOOK_SECRET=...
TAYPI_SANDBOX=true
TAYPI_API_URL=https://sandbox.taypi.pe
```

Activa producción solo con claves `*_live_*`, cuenta TAYPI verificada y webhook HTTPS configurado en `https://<dominio>/api/webhooks/taypi`. Antes de aceptar dinero real se debe completar KYB y hacer una operación controlada.

## Administración y roles

Firebase verifica la identidad. El API consulta `user_roles` en Neon para autorizar cada lectura o mutación. `ADMIN` administra usuarios, roles, montos rápidos, reportes y cancelaciones; `CASHIER` crea cobros y consulta el día de Lima. Nadie puede escribir `PAID` desde el navegador.

## Webhooks y conciliación

Un webhook es una llamada HTTPS del proveedor al backend cuando cambia una operación. El servidor valida firma, timestamp, referencia, monto, moneda e idempotencia; después registra `payment_events` en una transacción. Si llega tarde o se pierde, el cron `/api/cron/reconcile-payments` consulta TAYPI server-side. El frontend solo hace polling de lecturas autorizadas y nunca altera el ledger.

En Vercel Hobby el cron gratuito no garantiza intervalos de cinco minutos; para pruebas se puede invocar manualmente o usar un scheduler externo con `CRON_SECRET`. Una operación real requiere webhook público HTTPS y una frecuencia de conciliación acordada.

## Vercel

Importa el repositorio, configura las variables en Preview y Production y conecta el dominio. No publiques secretos en `VITE_*`. Mantén `PAYMENT_PROVIDER=mock` únicamente local; Preview/Production deben usar TAYPI sandbox o live con sus claves correspondientes.

El despliegue Preview creado durante la validación no tiene credenciales ni debe usarse para cobrar. Antes de una prueba real verifica en el panel que las variables estén completas, que `DATABASE_URL` conecta Neon y que Firebase autoriza el dominio.

## Limitaciones y seguridad

- Los planes gratuitos no ofrecen SLA ni respaldo financiero; configura exportaciones periódicas de Neon antes de operar.
- TAYPI puede cobrar comisión aunque la infraestructura sea gratuita.
- No se usa scraping, ingeniería inversa ni una API privada de Yape.
- No se almacenan PIN, OTP, contraseñas ni claves bancarias del cliente.
