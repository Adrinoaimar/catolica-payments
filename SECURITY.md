# Seguridad

## Reglas no negociables

- Nunca marcar `PAID` por respuesta, estado o texto controlado por el frontend.
- Nunca aceptar monto, referencia o `provider_payment_id` sin validación server-side.
- Nunca usar números flotantes para dinero; usar `amount_cents` entero y moneda `PEN`.
- Nunca almacenar claves bancarias, contraseñas, PIN, OTP ni credenciales financieras del cliente.
- Nunca hacer scraping, ingeniería inversa o interceptación de Yape/Plin. Integrar únicamente APIs y documentación autorizadas.
- Nunca confirmar secretos, `.env.local`, dumps, comprobantes, logs con payloads o datos de clientes.

## Límites de confianza

```text
Navegador del cajero/cliente (no confiable)
    | sesión + validación de entrada
API serverless (límite de autorización)
    | service role + transacción + auditoría
Supabase PostgreSQL (fuente de verdad)
    ^
Proveedor de pagos (webhook no confiable hasta verificar firma)
```

El navegador puede ser manipulado. Realtime, QR, contador y pantalla de éxito son señales de presentación, no evidencia de pago. Solo una transacción server-side con webhook autenticado o flujo efectivo autorizado puede cambiar el estado.

## Autenticación y autorización

- Usar Supabase Auth con sesión vigente y expiración razonable.
- Aplicar RBAC en cada endpoint, no solo ocultar controles en UI.
- `CASHIER` puede crear y consultar operaciones permitidas; no editar pagos terminales, auditoría ni configuración global.
- `ADMIN` recibe acciones adicionales según políticas RLS.
- Denegar por defecto y probar RLS con usuario anon, `CASHIER` y `ADMIN`.
- No registrar tokens de sesión ni service-role keys.

## Webhooks

Cada endpoint debe:

1. Leer el cuerpo sin transformaciones antes de verificar firma.
2. Verificar HMAC/firma y timestamp o ventana anti-replay según proveedor.
3. Validar esquema, proveedor esperado, `provider_event_id`, referencia, monto, moneda e identificador de pago.
4. Rechazar firmas ausentes, inválidas, payload truncado o eventos de otro entorno.
5. Ejecutar transición e inserción de auditoría en una transacción atómica.
6. Hacer deduplicación por identificador de evento/payment ID.
7. Responder rápido, sin incluir secretos ni stack traces.

No confiar en un campo de éxito sin verificarlo contra el proveedor cuando el contrato lo exija. No aceptar el mismo evento después de estado terminal salvo una política explícita y auditable.

## Datos y secretos

- `SUPABASE_ANON_KEY` puede llegar al cliente; `SUPABASE_SERVICE_ROLE_KEY` nunca.
- Claves Taypi/Culqi/Mercado Pago y secretos webhook solo en variables de entorno serverless.
- No usar prefijo `VITE_` para valores secretos.
- Redactar `raw_payload` y logs; conservar solo lo necesario para auditoría.
- Evitar almacenar datos personales del pagador; la referencia interna no debe contener PII.
- Separar Preview/Production y rotar claves ante exposición.

## Mock y desarrollo

`/dev/mock-payment/:reference` y `POST /api/webhooks/mock` solo se habilitan en desarrollo local explícito y requieren el proveedor mock. El servidor debe rechazar explícitamente las rutas cuando `NODE_ENV=production` o `VERCEL_ENV=preview`, aunque alguien conozca la URL. El mock no debe aceptar llamadas desde una aplicación desplegada con proveedor real.

## Validación y abuso

- Rechazar montos `<= 0`, exceso del límite operativo, más de dos decimales o moneda inesperada.
- Validar formato y longitud de referencias, UUID, estados y parámetros de filtros.
- Aplicar rate limiting por usuario/IP a creación de cobros y webhooks en el borde de producción (Vercel WAF o un gateway administrado); no usar un contador en memoria de una función serverless como control de seguridad.
- Usar límites de tamaño de body, timeouts y protección contra replay.
- No interpolar SQL; usar cliente parametrizado y funciones SQL revisadas.
- Escapar contenido exportado a CSV para evitar inyección de fórmulas.

## Operación y despliegue

- HTTPS obligatorio en producción.
- Headers de seguridad, CORS con allowlist y cookies seguras cuando aplique.
- Logs estructurados sin secretos, número completo de tarjeta o payload crudo sensible.
- Alertar por firmas inválidas repetidas, picos de fallos, transiciones rechazadas y discrepancias de monto.
- Revisar dependencias, lockfile y permisos antes de cada release.
- Verificar `git diff`, escaneo de secretos, tests, build y configuración Vercel antes de publicar.

## Respuesta a incidentes

1. Revocar/rotar la clave afectada.
2. Deshabilitar proveedor o endpoint comprometido si la operación lo requiere.
3. Preservar `payment_events`, logs sanitizados y ventana temporal.
4. Auditar pagos por referencia/payment ID y comparar con el proveedor.
5. Corregir, probar replay/idempotencia y documentar impacto.

Reportar cualquier hallazgo evitando incluir secretos o datos personales en issues públicos.
