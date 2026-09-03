import { useEffect, useState } from 'react'
import { ArrowIcon, CashIcon, ChevronIcon, ClockIcon, InfoIcon, QrIcon } from '../components/Icons'
import { formatSoles } from '../lib/format'
import { createPaymentRequest } from '../lib/demoStore'
import { DEFAULT_QUICK_AMOUNTS, fetchQuickAmounts } from '../lib/quickAmounts'
import type { Payment, PaymentMethod, SessionUser } from '../types'

interface CashierPageProps { user: SessionUser; onCreated: (payment: Payment) => void }
export function CashierPage({ user, onCreated }: CashierPageProps) {
  const [quickAmounts, setQuickAmounts] = useState(DEFAULT_QUICK_AMOUNTS)
  const [quickAmountsError, setQuickAmountsError] = useState('')
  const [amount, setAmount] = useState<number | null>(null)
  const [method, setMethod] = useState<PaymentMethod>('DIGITAL')
  const [custom, setCustom] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [retryKey, setRetryKey] = useState<string | null>(null)
  const selectedAmount = amount ?? parseSolesToCents(custom)

  useEffect(() => {
    let active = true
    void fetchQuickAmounts().then((items) => {
      if (!active) return
      setQuickAmounts(items.map((item) => item.amountCents))
      setQuickAmountsError('')
    }).catch((reason) => {
      if (!active) return
      setQuickAmountsError(reason instanceof Error ? reason.message : 'No se pudieron cargar los montos configurados.')
    })
    return () => { active = false }
  }, [])

  async function handleCreate() {
    if (selectedAmount <= 0 || busy) return
    setBusy(true)
    setError('')
    const idempotencyKey = retryKey ?? (crypto.randomUUID?.() ?? `catolica-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    if (!retryKey) setRetryKey(idempotencyKey)
    try {
      const payment = await createPaymentRequest(selectedAmount, method, user, idempotencyKey)
      setRetryKey(null)
      onCreated(payment)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo crear el cobro. Intenta nuevamente.')
    } finally { setBusy(false) }
  }

  return <div className="page-stack cashier-page">
    <div className="page-heading"><div><div className="eyebrow">PUNTO DE COBRO</div><h1>Nueva cobranza</h1><p>Selecciona un monto para comenzar una nueva operación.</p></div><div className="live-pill"><span className="status-dot status-dot--green" /> Caja activa</div></div>
    <div className="cashier-layout">
      <section className="panel amount-panel"><div className="panel-topline"><div><h2>¿Cuánto deseas cobrar?</h2><p>Elige un monto rápido o ingresa uno personalizado.</p></div><span className="step-badge">01</span></div>
        <div className="quick-grid" aria-label="Montos rápidos">{quickAmounts.map((quick) => <button type="button" key={quick} className={`amount-button ${amount === quick && !custom ? 'amount-button--selected' : ''}`} onClick={() => { setAmount(quick); setCustom(''); setRetryKey(null) }}><span>{formatSoles(quick).replace('.00', '')}</span>{amount === quick && !custom && <i>✓</i>}</button>)}</div>
        {quickAmountsError && <div className="form-note" role="status">{quickAmountsError} Se muestran los montos disponibles localmente.</div>}
        <div className="custom-amount"><label htmlFor="custom-amount">OTRO MONTO</label><div className={`amount-input ${custom ? 'amount-input--active' : ''}`}><span>S/</span><input id="custom-amount" inputMode="decimal" placeholder="0.00" value={custom} onChange={(event) => { setCustom(event.target.value); setAmount(null); setRetryKey(null) }} /><small>PEN</small></div></div>
        <div className="method-block"><div className="panel-topline panel-topline--method"><div><h2>¿Cómo pagará el cliente?</h2><p>Selecciona un método de pago.</p></div><span className="step-badge">02</span></div><div className="method-toggle"><button className={method === 'DIGITAL' ? 'method-toggle__active' : ''} onClick={() => { setMethod('DIGITAL'); setRetryKey(null) }}><span className="method-icon method-icon--digital"><QrIcon size={20} /></span><span><strong>Pago digital</strong><small>Yape, Plin o QR</small></span>{method === 'DIGITAL' && <i>✓</i>}</button><button className={method === 'CASH' ? 'method-toggle__active' : ''} onClick={() => { setMethod('CASH'); setRetryKey(null) }}><span className="method-icon method-icon--cash"><CashIcon size={20} /></span><span><strong>Efectivo</strong><small>Pago en caja</small></span>{method === 'CASH' && <i>✓</i>}</button></div></div>
        {error && <div className="form-error"><InfoIcon size={16} /> {error}</div>}<button className="primary-button create-charge-button" disabled={selectedAmount <= 0 || busy} onClick={handleCreate}>{busy ? 'Creando operación…' : <>Cobrar {selectedAmount > 0 ? formatSoles(selectedAmount) : ''}<ArrowIcon size={19} /></>}</button><div className="secure-note"><InfoIcon size={15} /> La operación quedará registrada y validada de forma segura.</div>
      </section>
      <aside className="panel cashier-preview"><div className="preview-label"><span className="preview-label__icon"><ClockIcon size={16} /></span> VISTA PREVIA</div><div className="preview-card"><div className="preview-card__top"><span className="mini-brand">LC</span><span className="preview-card__status">NUEVO COBRO</span></div><div className="preview-card__amount">{selectedAmount > 0 ? formatSoles(selectedAmount) : 'S/ 0.00'}</div><div className="preview-card__method"><span className={`preview-method-dot ${method === 'CASH' ? 'preview-method-dot--cash' : ''}`} /> {method === 'CASH' ? 'Pago en efectivo' : 'Pago digital'}</div>{method === 'DIGITAL' ? <div className="preview-qr-placeholder"><QrIcon size={30} /><span>El QR aparecerá aquí</span></div> : <div className="preview-cash-message"><CashIcon size={30} /><span>Listo para registrar<br />pago en caja</span></div>}<div className="preview-card__footer">Grupo La Católica <span>•</span> PEN</div></div><div className="preview-tip"><span>✦</span><p><strong>Cobro rápido</strong><br />Con los montos rápidos puedes generar una operación en un solo toque.</p></div></aside>
    </div>
  </div>
}

/** Parse user-entered soles without converting money through a floating point number. */
function parseSolesToCents(value: string): number {
  const normalized = value.trim().replace(',', '.')
  if (!normalized || !/^\d+(?:\.\d{0,2})?$/.test(normalized)) return 0
  const [whole, decimals = ''] = normalized.split('.')
  const cents = Number(whole) * 100 + Number(decimals.padEnd(2, '0'))
  return Number.isSafeInteger(cents) ? cents : 0
}
