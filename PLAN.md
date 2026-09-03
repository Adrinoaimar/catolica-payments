# Plan de implementación: Catolica Payments

## Objetivo

Construir una caja web para Grupo La Católica que genere cobros digitales por operación, reciba confirmaciones únicamente desde webhooks verificados y permita registrar efectivo. El modo `mock` debe cubrir el flujo completo sin credenciales ni costo, para demostraciones y pruebas.

## Alcance de Fase 1 (MVP)

1. Proyecto React/Vite/TypeScript con interfaz responsive para celular, tablet y PC.
2. Supabase Auth, PostgreSQL, migraciones, índices, constraints y RLS.
3. Modelo `payments` con dinero en centavos, estados explícitos y referencia única `CAT-YYYYMMDD-XXXXXX`.
4. Modelo de auditoría `payment_events` para cada cambio financiero.
5. Contrato `PaymentProvider` y selector por `PAYMENT_PROVIDER`.
6. `MockPaymentProvider`: QR de prueba, creación de sesión y webhook simulado.
7. Caja rápida: montos predefinidos, otro monto, pago digital y efectivo.
8. Pantalla de cobro con contador, estado pendiente, éxito y siguiente cobro.
9. Dashboard diario con totales digital/efectivo, operaciones y pendientes.
10. Tests unitarios e integración para dinero, referencias, idempotencia, validación, expiración y efectivo.

## Entregas por fase

### Fase 1 — MVP verificable

- [x] Instalar dependencias y configurar scripts `test` y `build`.
- [x] Crear migraciones y políticas RLS.
- [x] Implementar autenticación y autorización por rol (`ADMIN`, `CASHIER`).
- [x] Implementar servicio de pagos y adaptador mock.
- [x] Implementar endpoints de cobro, efectivo, consulta y `/api/webhooks/mock`.
- [x] Deshabilitar `/dev/mock-payment/:reference` en producción.
- [x] Conectar actualización de estado con Supabase Realtime y polling controlado.
- [x] Proteger la UI frente a respuestas fuera de orden y resincronizar al recuperar foco.
- [x] Ejecutar `npm install`, `npm test` y `npm run build`.

### Fase 2 — Taypi

- [x] Confirmar documentación y contrato vigente de Taypi antes de activar credenciales.
- [x] Implementar creación de checkout/QR, expiración y consulta en `TaypiProvider`.
- [x] Implementar verificación HMAC y normalización de estados.
- [x] Validar respuesta de creación, mapear checkout token y reintentar fallos transitorios con backoff acotado.
- [ ] Probar sandbox con reintentos y webhooks duplicados usando una cuenta Taypi.
- [x] Activar mediante `PAYMENT_PROVIDER=taypi`, sin cambios en UI ni servicio de dominio.
- [x] Añadir reconciliación server-side por polling como respaldo del webhook.
- [x] Registrar recibos de entrega sin payload duplicado y bloquear cron solapado con lease de Postgres.

### Fase 3 — Operación y reportes

- [x] Reportes diario, semanal, mensual y rango personalizado.
- [x] Filtros server-side, exportación CSV y permisos de administrador.
- [x] Cancelación de pendientes con validación del proveedor y auditoría atómica.
- [x] PWA instalable con manifest, icono institucional y service worker limitado al shell estático.
- [x] Gestión de usuarios y montos rápidos configurables desde administración.
- [ ] Mejoras UX y accesibilidad adicionales.

### Fase 4 — Proveedores adicionales

- [ ] `CulqiProvider`.
- [ ] `MercadoPagoProvider`.
- [ ] Tests de contrato comunes para todos los proveedores.

## Criterios de aceptación del MVP

- Un cajero autenticado selecciona `S/30` y obtiene un QR con referencia nueva en un toque.
- El pago inicia en `PENDING`; el frontend nunca puede marcarlo `PAID` por sí solo.
- El simulador llama al webhook mock. El mismo pipeline valida referencia, monto, proveedor e idempotencia y transiciona a `PAID`.
- Repetir el mismo `payment_id` cinco veces produce como máximo un cambio financiero y un evento efectivo.
- Un pago por efectivo queda `PAID`, con `provider=CASH` y usuario registrador.
- La pantalla de cobro y dashboard reflejan el pago sin recarga manual.
- Dinero se conserva como enteros en centavos; no se usan flotantes para cálculos financieros.
- `npm install`, `npm run test` y `npm run build` terminan correctamente.
- Producción rechaza rutas mock, secretos ausentes y webhooks no autenticados.

## Riesgos y decisiones

- Yape/Plin no se integran mediante scraping ni API privada. Solo se usarán APIs/documentación autorizadas del proveedor contratado.
- La confirmación del backend/webhook es la única fuente de verdad.
- La selección del proveedor queda fuera del dominio para impedir acoplamiento a una empresa.
- La operación atómica y una clave única de evento protegen frente a reintentos concurrentes.
- El repositorio público no contiene secretos, comprobantes, transcripciones ni datos de clientes.

## Secuencia de validación antes de publicar

1. Revisar `git diff` y secretos con un escáner local.
2. Aplicar migraciones en un proyecto Supabase de prueba.
3. Ejecutar tests y build de producción.
4. Probar login, cobro mock, webhook duplicado, monto incorrecto, expiración y efectivo.
5. Revisar rutas de webhook, cabeceras y variables en Vercel.
6. Crear commit descriptivo y conectar `main` a despliegue automático.
