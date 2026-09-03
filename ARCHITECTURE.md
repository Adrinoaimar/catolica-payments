# Arquitectura

## Principios

1. El backend es autoridad financiera. El navegador solo solicita operaciones y observa su estado.
2. Cada intento tiene `reference` y `provider_payment_id` únicos. El monto nunca identifica una operación.
3. El dominio depende de `PaymentProvider`, no de Taypi, Culqi o Mercado Pago.
4. Todas las transiciones financieras dejan una fila de auditoría.
5. Dinero se representa como enteros en centavos y moneda explícita (`PEN`).

## Capas

```text
React/Vite UI
    |
API serverless + Auth/RBAC
    |
Payment service (reglas, dinero, estados, idempotencia)
    |                    \
Supabase PostgreSQL       PaymentProvider adapter
                           |-- Mock
                           |-- Taypi
                           |-- Culqi
                           `-- Mercado Pago
```

La UI contiene presentación, selección rápida, accesibilidad, contador y suscripción de cambios. Las funciones serverless validan sesión y rol para acciones internas, y validan firma para webhooks. El servicio de pagos concentra reglas que deben ser iguales para todos los proveedores.

## Contrato de proveedor

La interfaz debe expresar datos normalizados, sin filtrar tipos del SDK externo al dominio:

```ts
interface PaymentProvider {
  createPayment(input: CreatePaymentInput): Promise<ProviderCheckout>;
  getPayment(input: GetPaymentInput): Promise<ProviderPayment>;
  verifyWebhook(input: VerifyWebhookInput): Promise<ProviderWebhookEvent>;
  cancelPayment(input: CancelPaymentInput): Promise<void>;
}
```

El selector lee `PAYMENT_PROVIDER` en el servidor. `MockPaymentProvider` usa un QR claramente identificado como prueba y entrega un evento al endpoint mock; no escribe directamente en `payments`. Los adaptadores reales encapsulan autenticación, formato de checkout/QR, consulta, cancelación, expiración, HMAC y mapeo de estados.

## Flujo de cobro digital

```text
CASHIER selecciona monto
  -> POST /api/payments
  -> validar sesión, rol, monto y límites
  -> generar referencia CAT-YYYYMMDD-XXXXXX
  -> insertar payment PENDING
  -> crear checkout mediante proveedor
  -> guardar datos no sensibles del proveedor
  -> mostrar QR y referencia
  -> proveedor envía webhook
  -> verificar firma y normalizar evento
  -> buscar reference + provider_payment_id
  -> comparar amount_cents/currency y estado
  -> transacción atómica + payment_events
  -> PENDING pasa a PAID
  -> UI recibe Realtime/polling y muestra éxito
```

La creación de la operación y de la sesión externa debe tolerar fallos: si el proveedor no crea checkout, se cancela o marca la operación según la política del servicio, sin mostrar un QR reutilizable. Un QR expirado nunca se reutiliza.

## Flujo de efectivo

`POST /api/payments/cash` exige sesión `CASHIER` o `ADMIN`, monto positivo y confirmación explícita. El backend crea la operación con `provider=CASH`, `status=PAID`, `paid_at=now()` y `created_by` del usuario. No llama proveedor ni webhook. La auditoría conserva el registro del usuario y del método.

## Estados

Estados permitidos: `PENDING`, `PAID`, `FAILED`, `EXPIRED`, `CANCELLED`.

Transiciones normales:

```text
PENDING -> PAID       webhook válido o efectivo confirmado
PENDING -> FAILED     rechazo definitivo del proveedor
PENDING -> EXPIRED    límite de 15 minutos alcanzado
PENDING -> CANCELLED  cancelación autorizada
```

`PAID`, `FAILED`, `EXPIRED` y `CANCELLED` son terminales para el webhook. Un cajero nunca puede editar manualmente una operación terminal. La expiración debe ejecutarse en backend (job, función invocada o comprobación transaccional al leer/escribir), no confiar en un temporizador del navegador.

## Idempotencia y concurrencia

`payments.reference`, `payments.provider_payment_id` y la identidad del evento del proveedor deben tener constraints únicos. El handler de webhook:

1. Verifica autenticidad antes de usar datos del payload.
2. Busca operación por referencia y proveedor/payment ID.
3. Toma la fila o usa una función SQL transaccional.
4. Revisa que el estado aún sea procesable.
5. Comprueba monto y moneda en centavos.
6. Inserta `payment_events` con `provider_event_id` único.
7. Cambia estado y `paid_at` en la misma transacción.

Reintentos concurrentes reciben resultado idempotente; una misma confirmación no suma dos veces ni crea dos eventos financieros.

## Modelo de datos

`payments` contiene como mínimo:

```text
id UUID PRIMARY KEY
reference TEXT UNIQUE NOT NULL
amount_cents INTEGER NOT NULL
currency TEXT NOT NULL DEFAULT 'PEN'
provider TEXT NOT NULL
provider_payment_id TEXT UNIQUE
status TEXT NOT NULL
created_by UUID
created_at TIMESTAMP
expires_at TIMESTAMP
paid_at TIMESTAMP
cancelled_at TIMESTAMP
provider_data JSONB
```

`payment_events` conserva `payment_id`, `event_type`, estados anterior/nuevo, proveedor, `provider_event_id` único, `raw_payload` y `created_at`. El payload crudo debe minimizar datos personales y cifrarse o restringirse según el entorno.

Índices previstos: referencia, fecha de creación, estado, proveedor/payment ID, `created_by` y fecha de eventos. Constraints validan monto positivo, moneda soportada, estados y consistencia de timestamps.

## Auth, roles y RLS

Supabase Auth identifica al usuario. El perfil/claim de rol permite `ADMIN` y `CASHIER`.

- `CASHIER`: crear cobros digitales/efectivo, leer operaciones del día y pagos confirmados.
- `ADMIN`: alcance global, estadísticas, usuarios, montos rápidos, cancelación de pendientes y reportes.
- Ningún cliente: escribir `PAID`, modificar `provider_payment_id`, editar auditoría o leer secretos.
- Webhooks: rutas públicas limitadas a verificación criptográfica y servicio server-side; no se abre RLS al anónimo.

El cliente usa anon key con RLS. La service-role key solo existe en serverless y no se importa en módulos del navegador.

## API mínima

```text
POST /api/payments              Crear checkout digital
POST /api/payments/cash         Registrar efectivo
GET  /api/payments/:reference   Consultar operación autorizada
POST /api/payments/:id/cancel   Cancelar pendiente (ADMIN)
POST /api/webhooks/mock
POST /api/webhooks/taypi
POST /api/webhooks/mercadopago
POST /api/webhooks/culqi
GET  /api/dashboard              Resumen y últimas operaciones
```

Respuestas no deben incluir secretos ni payloads sensibles. Errores de validación son explícitos; el webhook responde rápidamente y no ejecuta trabajo pesado dentro de la solicitud.

## Realtime y experiencia

La pantalla de cobro se suscribe a cambios de su `payment.id`/`reference`, con polling de respaldo y límite de tiempo. Realtime solo informa al cliente; nunca autoriza una transición. Al observar `PAID`, la UI muestra monto, referencia, hora y confirmación sonora opcional, luego permite **Nuevo cobro**.

Dashboard agrega por `amount_cents` y separa `provider=CASH` de pagos digitales. Conversión a soles ocurre únicamente en la capa de presentación/exportación.

## Despliegue

Vercel sirve el frontend y funciones serverless desde el mismo repositorio GitHub. Variables públicas y secretas se separan por ambiente. Preview usa el mock; Production usa proveedor real solo con firma/webhook probados. Webhooks deben apuntar a HTTPS. GitHub Pages no ejecuta backend ni debe contener variables secretas.
