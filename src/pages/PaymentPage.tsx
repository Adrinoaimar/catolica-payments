import { useEffect, useRef, useState } from 'react'
import { ArrowIcon, CheckIcon, ClockIcon, CloseIcon, CopyIcon, InfoIcon, QrIcon } from '../components/Icons'
import { QrCode } from '../components/QrCode'
import { formatSoles } from '../lib/format'
import { simulateMockPayment } from '../lib/demoStore'
import { apiFetch } from '../lib/firebase'
import { fetchPublicPayment } from '../lib/realtime'
import type { Payment } from '../types'

interface PaymentPageProps {
  payment: Payment
  onPaid: (payment: Payment) => void
  onNew: () => void
  onSimulator: (payment: Payment) => void
  onCancelled?: (payment: Payment) => void
  canCancel?: boolean
  demoMode?: boolean
}

type TerminalPaymentStatus = Exclude<Payment['status'], 'PENDING' | 'PAID'>

const terminalStatusCopy: Record<TerminalPaymentStatus, { eyebrow: string; title: string; description: string; label: string }> = {
  FAILED: {
    eyebrow: 'PAGO NO COMPLETADO',
    title: 'No se pudo completar el pago',
    description: 'El proveedor reportó que esta operación no terminó correctamente. No vuelvas a compartir este código.',
    label: 'Pago fallido',
  },
  EXPIRED: {
    eyebrow: 'CÓDIGO VENCIDO',
    title: 'El cobro expiró',
    description: 'Terminó el plazo disponible para pagar. Este código QR ya no puede utilizarse.',
    label: 'Cobro vencido',
  },
  CANCELLED: {
    eyebrow: 'COBRO CANCELADO',
    title: 'Operación cancelada',
    description: 'Esta operación fue cancelada y no puede volver a pagarse con este código.',
    label: 'Cobro cancelado',
  },
}

export function PaymentPage({ payment, onPaid, onNew, onSimulator, onCancelled, canCancel = false, demoMode = false }: PaymentPageProps) {
  const [current, setCurrent] = useState(payment)
  const [seconds, setSeconds] = useState(15 * 60)
  const [copied, setCopied] = useState(false)
  const [paying, setPaying] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)
  const [reconciling, setReconciling] = useState(false)
  const [reconcileCooldown, setReconcileCooldown] = useState(0)
  const [reconcileError, setReconcileError] = useState<string | null>(null)
  const [reconcileMessage, setReconcileMessage] = useState<string | null>(null)
  const previousStatus = useRef<Payment['status']>(payment.status)
  useEffect(() => { setCurrent(payment); setSeconds(Math.max(0, payment.expiresAt ? Math.floor((new Date(payment.expiresAt).getTime() - Date.now()) / 1000) : 15 * 60)) }, [payment])
  useEffect(() => {
    if (previousStatus.current === 'PENDING' && current.status === 'PAID') playSuccessTone()
    previousStatus.current = current.status
  }, [current.status])
  useEffect(() => { if (current.status !== 'PENDING') return; const interval = window.setInterval(() => setSeconds((value) => Math.max(0, value - 1)), 1000); return () => window.clearInterval(interval) }, [current.status])
  useEffect(() => {
    if (reconcileCooldown <= 0) return
    const timer = window.setInterval(() => setReconcileCooldown((value) => Math.max(0, value - 1)), 1000)
    return () => window.clearInterval(timer)
  }, [reconcileCooldown])
  useEffect(() => {
    if (!demoMode || current.status !== 'PENDING' || seconds > 0) return
    const expired = { ...current, status: 'EXPIRED' as const }
    setCurrent(expired)
    onPaid(expired)
  }, [current, demoMode, onPaid, seconds])
  const mins = String(Math.floor(seconds / 60)).padStart(2, '0'); const secs = String(seconds % 60).padStart(2, '0')
  async function handleCopy() { await navigator.clipboard?.writeText(current.reference); setCopied(true); window.setTimeout(() => setCopied(false), 1800) }
  async function fallbackDemoPay() { setPaying(true); const result = await simulateMockPayment(current); setCurrent(result); onPaid(result); setPaying(false) }
  async function handleReconcile() {
    if (demoMode || current.status !== 'PENDING' || reconciling || reconcileCooldown > 0) return
    setReconciling(true)
    setReconcileCooldown(5)
    setReconcileError(null)
    setReconcileMessage(null)
    try {
      const response = await apiFetch(`/api/payments/${encodeURIComponent(current.reference)}/reconcile`, { method: 'POST' })
      const body = await response.json().catch(() => ({})) as { error?: unknown }
      if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'No se pudo verificar el estado del cobro.')
      // Ignore the response body as UI authority; rehydrate through the same
      // authenticated, sanitized payment endpoint used by Realtime events.
      const next = await fetchPublicPayment(current.reference)
      setCurrent(next)
      if (next.status !== 'PENDING') onPaid(next)
      setReconcileMessage(next.status === 'PENDING' ? 'El proveedor todavía reporta el cobro pendiente.' : 'Estado actualizado desde el proveedor.')
    } catch (error) {
      setReconcileError(error instanceof Error ? error.message : 'No se pudo verificar el estado del cobro.')
    } finally {
      setReconciling(false)
    }
  }
  async function handleCancel() {
    if (!canCancel || demoMode || current.status !== 'PENDING' || cancelling) return
    if (!window.confirm('¿Confirmas cancelar este cobro pendiente? Esta acción no se puede deshacer.')) return
    const reason = window.prompt('Motivo de cancelación (opcional):')
    if (reason === null) return
    setCancelling(true)
    setCancelError(null)
    try {
      const response = await apiFetch(`/api/payments/${encodeURIComponent(current.reference)}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      })
      const body = await response.json().catch(() => ({})) as { payment?: Payment; error?: unknown }
      if (!response.ok || !body.payment) throw new Error(typeof body.error === 'string' ? body.error : 'No se pudo cancelar el cobro.')
      setCurrent(body.payment)
      onCancelled?.(body.payment)
    } catch (error) {
      setCancelError(error instanceof Error ? error.message : 'No se pudo cancelar el cobro.')
    } finally {
      setCancelling(false)
    }
  }

  if (current.status === 'PAID') return <div className="page-stack payment-page"><div className="payment-success"><div className="success-orb"><CheckIcon size={38} /></div><div className="eyebrow eyebrow--success">PAGO CONFIRMADO</div><h1>¡Pago recibido!</h1><div className="success-amount">{formatSoles(current.amountCents)}</div><p>La operación fue confirmada y registrada correctamente.</p><div className="success-reference"><span>Operación</span><strong>{current.reference}</strong></div><div className="success-actions"><button className="primary-button" onClick={onNew}>Nuevo cobro <ArrowIcon size={18} /></button><button className="secondary-button" onClick={handleCopy}><CopyIcon size={15} />{copied ? 'Referencia copiada' : 'Copiar referencia'}</button></div></div></div>
  if (current.status !== 'PENDING') {
    const terminal = terminalStatusCopy[current.status]
    return <div className="page-stack payment-page"><div className={`payment-terminal payment-terminal--${current.status.toLowerCase()}`} role="status" aria-live="polite"><div className="terminal-orb">{current.status === 'EXPIRED' ? <ClockIcon size={34} /> : current.status === 'CANCELLED' ? <CloseIcon size={34} /> : <InfoIcon size={34} />}</div><div className="eyebrow eyebrow--terminal">{terminal.eyebrow}</div><h1>{terminal.title}</h1><div className="terminal-amount">{formatSoles(current.amountCents)}</div><p>{terminal.description}</p><div className="terminal-reference"><div><span>Estado</span><strong>{terminal.label}</strong></div><div><span>Referencia</span><strong>{current.reference}</strong></div></div><div className="terminal-actions"><button className="primary-button" onClick={onNew}>Crear nuevo cobro <ArrowIcon size={18} /></button><button className="secondary-button" onClick={handleCopy}><CopyIcon size={15} />{copied ? 'Referencia copiada' : 'Copiar referencia'}</button></div><small className="terminal-note">El estado mostrado proviene del proveedor de pagos.</small></div></div>
  }
  return <div className="page-stack payment-page"><div className="payment-heading"><button className="back-link" onClick={onNew}>← Volver a nueva cobranza</button><div className="eyebrow">COBRO DIGITAL</div><h1>Esperando el pago</h1><p>Comparte este código QR con tu cliente para completar el pago.</p></div><div className="payment-layout"><section className="panel payment-qr-card"><div className="payment-qr-card__head"><span className="live-pill live-pill--pending"><span className="status-dot status-dot--amber" /> Esperando confirmación</span><span className="secure-label"><InfoIcon size={14} /> Seguro</span></div><div className="qr-wrap">{current.qrCode ? <img className="provider-qr-image" src={current.qrCode} alt={`Código QR de ${current.reference}`} /> : demoMode ? <QrCode value={current.reference} /> : <div className="provider-qr-missing"><InfoIcon size={22} /><strong>QR no disponible</strong><small>El proveedor no devolvió un código QR para esta operación.</small></div>}{current.checkoutUrl && <a className="secondary-button provider-checkout-link" href={current.checkoutUrl} target="_blank" rel="noreferrer">Abrir checkout seguro <ArrowIcon size={15} /></a>}<div className="qr-scan-hint"><QrIcon size={16} /> Escanea con la billetera digital</div></div><div className="payment-amount-label">TOTAL A PAGAR</div><div className="payment-amount">{formatSoles(current.amountCents)}</div><div className="payment-reference"><span>Referencia</span><strong>{current.reference}</strong><button className="icon-button" onClick={handleCopy} aria-label="Copiar referencia"><CopyIcon size={16} />{copied && <em>Copiado</em>}</button></div></section><aside className="payment-details"><div className="panel expiry-card"><div className="expiry-card__icon"><ClockIcon size={20} /></div><div><span>Este código vence en</span><strong>{mins}:{secs}</strong></div><small>La operación se cancela automáticamente al vencer.</small></div><div className="panel reconcile-card"><div><span className="reconcile-card__icon"><InfoIcon size={16} /></span><p><strong>¿Ya pagó el cliente?</strong><small>Consulta el estado directamente en el servidor.</small></p></div><button className="secondary-button" disabled={reconciling || reconcileCooldown > 0} onClick={handleReconcile}>{reconciling ? 'Verificando…' : reconcileCooldown > 0 ? `Verificar de nuevo (${reconcileCooldown}s)` : 'Verificar estado'}</button>{reconcileMessage && <div className="form-note" role="status">{reconcileMessage}</div>}{reconcileError && <div className="form-error" role="alert"><InfoIcon size={14} /> {reconcileError}</div>}</div><div className="panel operation-card"><div className="operation-card__title">DETALLE DE OPERACIÓN <span className="step-badge">03</span></div><div className="operation-row"><span>Monto</span><strong>{formatSoles(current.amountCents)}</strong></div><div className="operation-row"><span>Método</span><strong><span className="method-dot" /> Pago digital</strong></div><div className="operation-row"><span>Cajero</span><strong>{current.createdBy}</strong></div><div className="operation-row"><span>Creada</span><strong>{new Date(current.createdAt).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })}</strong></div></div>{canCancel && !demoMode && <div className="panel cancel-card"><div><span className="cancel-card__icon"><CloseIcon size={16} /></span><p><strong>Acción administrativa</strong><small>Solo puedes cancelar mientras el proveedor siga en estado pendiente.</small></p></div><button className="secondary-button cancel-payment-button" disabled={cancelling} onClick={handleCancel}>{cancelling ? 'Cancelando…' : 'Cancelar cobro'}</button>{cancelError && <div className="form-error" role="alert"><InfoIcon size={14} /> {cancelError}</div>}</div>}{demoMode && <div className="panel simulator-card"><div><span className="simulator-card__icon">⚙</span><p><strong>¿Estás probando el sistema?</strong><small>Usa el simulador para confirmar este pago.</small></p></div><button className="secondary-button" disabled={paying} onClick={() => onSimulator(current)}>Abrir simulador <ArrowIcon size={15} /></button><button className="ghost-demo-button" disabled={paying} onClick={fallbackDemoPay}>{paying ? 'Procesando…' : 'Confirmar demo rápidamente'}</button></div>}</aside></div></div>
}

/** Optional local confirmation sound; failure is harmless when autoplay is blocked. */
function playSuccessTone(): void {
  try {
    const context = new AudioContext()
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(880, context.currentTime)
    oscillator.frequency.exponentialRampToValueAtTime(1_320, context.currentTime + 0.12)
    gain.gain.setValueAtTime(0.0001, context.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.08, context.currentTime + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.22)
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start()
    oscillator.stop(context.currentTime + 0.22)
    oscillator.addEventListener('ended', () => { void context.close() }, { once: true })
  } catch {
    // Browsers may block Web Audio until a gesture; visual confirmation remains.
  }
}
