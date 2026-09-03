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
- Proveedores: `MockPaymentProvider`, `TaypiProvider`, `CulqiProvider` y `MercadoPagoProvider` detrás de una interfaz común.

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

La sesión del navegador usa Supabase Auth (Email/Password), persiste mediante el cliente oficial y envía `Authorization: Bearer <access_token>` a cada endpoint protegido. Cada usuario debe tener una fila en `public.user_roles` con rol `ADMIN` o `CASHIER`; el frontend no acepta el rol desde metadata para autorizar operaciones.

Ejecute las migraciones de `supabase/migrations/` en el proyecto Supabase. Después inicie el entorno:

```bash
npm run dev
```

Scripts esperados:

```bash
npm run test
npm run build
```

## Variables de entorno

Consulte [.env.example](.env.example). `PAYMENT_PROVIDER=mock` es la configuración segura para desarrollo. `VITE_DEMO_MODE=true` habilita explícitamente el flujo offline local y solo tiene efecto en builds no productivos; sin esa bandera, la app falla cerrado si Supabase no está configurado y nunca crea sesiones falsas ni recupera pagos desde `localStorage`. Las claves `SUPABASE_SERVICE_ROLE_KEY` y de proveedores solo deben existir en el backend/serverless; nunca deben exponerse como variables `VITE_*` ni enviarse al navegador.

## Probar el flujo mock

1. Inicie sesión con un usuario de rol `CASHIER`.
2. Seleccione `S/10`, `S/20`, `S/30`, `S/40`, `S/50` u otro monto.
3. Elija **Pago digital** y genere el cobro.
4. Abra `/dev/mock-payment/<reference>` en otra pestaña o use el enlace del QR.
5. Pulse **Simular pago exitoso**.
6. El simulador llama `POST /api/webhooks/mock`; no actualiza la base de datos directamente.
7. Verifique `PAID`, el mensaje `PAGO RECIBIDO` y el registro en el dashboard.

La ruta `/dev/mock-payment/:reference` debe existir solo cuando el entorno no es producción. El mock no representa una integración real con Yape o Plin.

Para efectivo, seleccione el monto, **Efectivo** y confirme. Se crea una operación `PAID` con `provider=CASH` y el usuario autenticado como registrador.

## Estados y webhooks

Las operaciones digitales siguen `PENDING -> PAID`, o `PENDING -> EXPIRED`, `FAILED` o `CANCELLED` según resultado. Los endpoints públicos son:

```text
POST /api/webhooks/mock
POST /api/webhooks/taypi
POST /api/webhooks/mercadopago
POST /api/webhooks/culqi
```

Cada adaptador debe autenticar el evento, buscar la referencia, comparar monto y moneda, validar `provider_payment_id`, rechazar duplicados de forma idempotente y registrar `payment_events` dentro de una operación atómica. Responda rápido con HTTP 200 solo después de aceptar el evento; eventos inválidos deben rechazarse con el código apropiado sin modificar pagos.

## Activar Taypi

La integración de `TaypiProvider` usa la API REST oficial de TAYPI. Configure las claves en el entorno serverless (nunca en `VITE_*`) y cambie:

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

Para sandbox use claves `taypi_pk_test_*`/`taypi_sk_test_*`, `TAYPI_SANDBOX=true` y `TAYPI_API_URL=https://sandbox.taypi.pe`. Si `TAYPI_API_URL` queda vacío, el adaptador selecciona sandbox para una public key `*_test_*` y producción para una public key `*_live_*`.

El adaptador llama `POST /api/v1/payments` con monto decimal (por ejemplo, `"30.50"`), `currency: "PEN"` y la referencia como `Idempotency-Key`. Firma cada request con HMAC-SHA256 sobre `{timestamp}\n{method}\n{path}\n{body}`, envía `Authorization: Bearer <TAYPI_PUBLIC_KEY>` y conserva el `payment_id`, `qr_image`, `checkout_url` y `expires_at` devueltos por TAYPI. Las consultas usan `GET /api/v1/payments/:payment_id`; las cancelaciones, `POST /api/v1/payments/:payment_id/cancel`.

Configure en el panel de TAYPI el webhook `https://<dominio-produccion>/api/webhooks/taypi`. El endpoint conserva el body crudo, valida `Taypi-Signature` (`sha256=<hex>`) con `TAYPI_WEBHOOK_SECRET`, compara referencia, monto y moneda en el servicio de pagos, y acepta `payment.completed`, `payment.expired`, `payment.cancelled`, `payment.failed` y `payment.rejected`. Los webhooks no se consideran confirmación hasta superar todas esas validaciones.

Antes de procesar dinero real, complete la verificación KYB de la cuenta de TAYPI, registre el webhook HTTPS de producción y ejecute un pago real de extremo a extremo. Las claves de sandbox no procesan dinero real ni funcionan en `app.taypi.pe`.

## Supabase

1. Cree un proyecto y habilite Email/Password o el proveedor de Auth seleccionado.
2. Ejecute las migraciones en `supabase/migrations/`.
3. Asigne roles mediante el mecanismo definido por las migraciones (`ADMIN` o `CASHIER`).
4. Configure Realtime para `payments` si la interfaz lo utiliza.
5. Verifique RLS con ambos roles antes de publicar.

El navegador usa únicamente la URL y anon key. La service-role key se reserva para funciones serverless y tareas administrativas.

## Despliegue en Vercel

1. Suba el repositorio a GitHub.
2. En Vercel, importe el repositorio y seleccione el framework detectado por el proyecto.
3. Configure las variables de entorno por ambiente (Preview y Production).
4. Mantenga `PAYMENT_PROVIDER=mock` en Preview hasta validar el sandbox.
5. Configure las URLs de webhook del proveedor hacia el dominio de producción.
6. Proteja Production con claves reales solo después de revisar logs y pruebas.

Cada push a `main` puede generar el despliegue de producción mediante la integración oficial GitHub-Vercel. No use GitHub Pages para secretos, funciones serverless o webhooks.

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
