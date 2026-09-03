import { useEffect, useMemo, useState } from 'react'
import { ArrowIcon, CashIcon, ChartIcon, ClockIcon, DownloadIcon, FilterIcon, PlusIcon, QrIcon, ReceiptIcon, SearchIcon } from '../components/Icons'
import { formatSoles } from '../lib/format'
import { downloadPaymentsCsv, fetchReportPayments, type PaymentReportFilters, type ReportPeriod } from '../lib/reporting'
import type { Payment, PaymentMethod, PaymentStatus, SessionUser } from '../types'
import type { AppSection } from '../components/Sidebar'

interface BackOfficePageProps {
  section: AppSection
  payments: Payment[]
  user: SessionUser
  onNew: () => void
  onOpenPayment: (payment: Payment) => void
}

const statusLabels: Record<PaymentStatus, string> = {
  PAID: 'Pagado',
  PENDING: 'Pendiente',
  FAILED: 'Fallido',
  EXPIRED: 'Vencido',
  CANCELLED: 'Cancelado',
}

const periodLabels: Record<ReportPeriod, string> = {
  ALL: 'Todo el historial',
  DAY: 'Hoy',
  WEEK: 'Esta semana',
  MONTH: 'Este mes',
  CUSTOM: 'Rango personalizado',
}

export function BackOfficePage({ section, payments, user, onNew, onOpenPayment }: BackOfficePageProps) {
  const [period, setPeriod] = useState<ReportPeriod>('DAY')
  const [status, setStatus] = useState<'ALL' | PaymentStatus>('ALL')
  const [method, setMethod] = useState<'ALL' | PaymentMethod>('ALL')
  const [cashier, setCashier] = useState('')
  const [query, setQuery] = useState('')
  const [minAmount, setMinAmount] = useState('')
  const [maxAmount, setMaxAmount] = useState('')
  const [fromDate, setFromDate] = useState(localDateValue(new Date()))
  const [toDate, setToDate] = useState(localDateValue(new Date()))
  const [visiblePayments, setVisiblePayments] = useState<Payment[]>(payments)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const cashiers = useMemo(() => Array.from(new Set(payments.map((payment) => payment.createdBy).filter(Boolean))).sort((a, b) => a.localeCompare(b)), [payments])
  const parsedAmounts = useMemo(() => ({ min: parseSolesFilter(minAmount), max: parseSolesFilter(maxAmount) }), [minAmount, maxAmount])
  const filters = useMemo<PaymentReportFilters | null>(() => {
    if (minAmount.trim() && parsedAmounts.min === null) return null
    if (maxAmount.trim() && parsedAmounts.max === null) return null
    if (parsedAmounts.min !== null && parsedAmounts.max !== null && parsedAmounts.min > parsedAmounts.max) return null
    const next: PaymentReportFilters = {
      period,
      ...(status !== 'ALL' ? { status } : {}),
      ...(method !== 'ALL' ? { method } : {}),
      ...(user.role === 'ADMIN' && cashier ? { createdBy: cashier } : {}),
      ...(parsedAmounts.min !== null ? { minAmountCents: parsedAmounts.min } : {}),
      ...(parsedAmounts.max !== null ? { maxAmountCents: parsedAmounts.max } : {}),
      limit: 200,
    }
    if (period === 'CUSTOM') {
      next.from = dateInputToIso(fromDate, false)
      next.to = dateInputToIso(toDate, true)
    }
    return next
  }, [cashier, fromDate, maxAmount, method, parsedAmounts.max, parsedAmounts.min, period, status, toDate, user.role, minAmount])

  useEffect(() => {
    if (!filters) {
      setError('El rango de monto no es válido. Usa soles con hasta dos decimales.')
      return
    }
    if (period === 'CUSTOM' && fromDate && toDate && fromDate > toDate) {
      setError('La fecha inicial no puede ser posterior a la fecha final.')
      return
    }
    let active = true
    setLoading(true)
    setError(null)
    void fetchReportPayments(filters, payments)
      .then((next) => {
        if (!active) return
        const normalizedQuery = query.trim().toLowerCase()
        setVisiblePayments(normalizedQuery ? next.filter((payment) => searchablePaymentText(payment).includes(normalizedQuery)) : next)
      })
      .catch((reason) => {
        if (!active) return
        setError(reason instanceof Error ? reason.message : 'No se pudieron cargar las operaciones.')
        setVisiblePayments([])
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [filters, fromDate, payments, period, query, toDate])

  const paid = visiblePayments.filter((payment) => payment.status === 'PAID')
  const digital = paid.filter((payment) => payment.method === 'DIGITAL')
  const cash = paid.filter((payment) => payment.method === 'CASH')
  const pending = visiblePayments.filter((payment) => payment.status === 'PENDING')
  const total = paid.reduce((sum, payment) => sum + payment.amountCents, 0)

  const reportToolbar = <>
    <div className="report-filter-group"><label htmlFor="report-period">Periodo</label><select id="report-period" value={period} onChange={(event) => setPeriod(event.target.value as ReportPeriod)}>{Object.entries(periodLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
    {period === 'CUSTOM' && <><div className="report-filter-group"><label htmlFor="report-from">Desde</label><input id="report-from" type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} /></div><div className="report-filter-group"><label htmlFor="report-to">Hasta</label><input id="report-to" type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} /></div></>}
    <div className="report-filter-group"><label htmlFor="report-status">Estado</label><select id="report-status" value={status} onChange={(event) => setStatus(event.target.value as typeof status)}><option value="ALL">Todos</option><option value="PAID">Pagados</option><option value="PENDING">Pendientes</option><option value="FAILED">Fallidos</option><option value="EXPIRED">Vencidos</option><option value="CANCELLED">Cancelados</option></select></div>
    <div className="report-filter-group"><label htmlFor="report-method">Método</label><select id="report-method" value={method} onChange={(event) => setMethod(event.target.value as typeof method)}><option value="ALL">Todos</option><option value="DIGITAL">Digital</option><option value="CASH">Efectivo</option></select></div>
    {user.role === 'ADMIN' && <div className="report-filter-group"><label htmlFor="report-cashier">Usuario/cajero</label><select id="report-cashier" value={cashier} onChange={(event) => setCashier(event.target.value)}><option value="">Todos</option>{cashiers.map((value) => <option key={value} value={value}>{value}</option>)}</select></div>}
    <div className="report-filter-group report-filter-group--amount"><label htmlFor="report-min-amount">Monto mínimo (S/)</label><input id="report-min-amount" inputMode="decimal" placeholder="0.00" value={minAmount} onChange={(event) => setMinAmount(event.target.value)} /></div>
    <div className="report-filter-group report-filter-group--amount"><label htmlFor="report-max-amount">Monto máximo (S/)</label><input id="report-max-amount" inputMode="decimal" placeholder="0.00" value={maxAmount} onChange={(event) => setMaxAmount(event.target.value)} /></div>
  </>

  if (section === 'dashboard') return <div className="page-stack"><div className="page-heading"><div><div className="eyebrow">CONTROL EN TIEMPO REAL</div><h1>Resumen del día</h1><p>Ventas, métodos y estados de tu caja.</p></div><button className="primary-button" onClick={onNew}><PlusIcon size={17} /> Nuevo cobro</button></div><div className="panel report-toolbar">{reportToolbar}</div><Stats total={total} digital={digital} cash={cash} pending={pending.length} operations={visiblePayments.length} /><PaymentTable payments={visiblePayments.slice(0, 10)} loading={loading} onOpenPayment={onOpenPayment} title="Últimas operaciones" /><div className="dashboard-bottom-grid"><section className="panel weekly-panel"><div className="panel-heading-row"><div><h2>Distribución del periodo</h2><p>{visiblePayments.length} operaciones encontradas</p></div><span className="chart-legend"><i /> Pagos confirmados</span></div><MethodBars total={total} digital={digital.reduce((sum, payment) => sum + payment.amountCents, 0)} cash={cash.reduce((sum, payment) => sum + payment.amountCents, 0)} /></section><section className="panel quick-help"><div className="quick-help__icon">✦</div><h2>Sincronización activa</h2><p>Realtime actualiza el estado. Los filtros siempre consultan el ledger autorizado.</p></section></div>{error && <div className="form-error" role="alert"><InfoIconFallback /> {error}</div>}</div>

  return <div className="page-stack"><div className="page-heading"><div><div className="eyebrow">{section === 'reports' ? 'ANÁLISIS Y EXPORTACIÓN' : 'CONTROL FINANCIERO'}</div><h1>{section === 'reports' ? 'Reportes' : 'Operaciones'}</h1><p>{section === 'reports' ? 'Consulta y descarga el detalle de tus operaciones.' : 'Consulta y filtra cada cobro registrado.'}</p></div><div className="heading-actions"><button className="primary-button" onClick={onNew}><PlusIcon size={17} /> Nuevo cobro</button>{section === 'reports' && <button className="secondary-button" disabled={loading || !visiblePayments.length} onClick={() => downloadPaymentsCsv(visiblePayments)}><DownloadIcon size={16} /> Exportar CSV</button>}</div></div><div className="panel report-toolbar">{reportToolbar}</div><div className="panel toolbar"><div className="search-field"><SearchIcon size={17} /><input aria-label="Buscar referencia o cajero" placeholder="Buscar referencia o cajero" value={query} onChange={(event) => setQuery(event.target.value)} /></div><span className="toolbar-result">{loading ? 'Cargando…' : `${visiblePayments.length} operaciones`}</span><FilterIcon size={16} /></div>{section === 'reports' && <Stats total={total} digital={digital} cash={cash} pending={pending.length} operations={visiblePayments.length} />}<PaymentTable payments={visiblePayments} loading={loading} onOpenPayment={onOpenPayment} title={section === 'reports' ? 'Resumen de operaciones' : 'Operaciones registradas'} />{section === 'reports' && <section className="panel report-panel"><div className="panel-title-row"><div><h2>Distribución por método</h2><p>Periodo: {periodLabels[period]}</p></div></div><MethodBars total={total} digital={digital.reduce((sum, payment) => sum + payment.amountCents, 0)} cash={cash.reduce((sum, payment) => sum + payment.amountCents, 0)} /></section>}{error && <div className="form-error" role="alert"><InfoIconFallback /> {error}</div>}</div>
}

function Stats({ total, digital, cash, pending, operations }: { total: number; digital: Payment[]; cash: Payment[]; pending: number; operations: number }) {
  return <div className="metrics-grid"><Metric label="Ventas confirmadas" value={formatSoles(total)} icon={<ChartIcon size={17} />} /><Metric label="Pagos digitales" value={formatSoles(digital.reduce((sum, payment) => sum + payment.amountCents, 0))} icon={<QrIcon size={17} />} /><Metric label="Efectivo" value={formatSoles(cash.reduce((sum, payment) => sum + payment.amountCents, 0))} icon={<CashIcon size={17} />} /><Metric label="Operaciones" value={String(operations)} detail={`${pending} pendientes`} icon={<ReceiptIcon size={17} />} /></div>
}

function Metric({ label, value, detail, icon }: { label: string; value: string; detail?: string; icon: React.ReactNode }) {
  return <div className="metric-card"><div className="metric-card__head"><span>{label}</span><span className="metric-icon">{icon}</span></div><strong>{value}</strong><div className="metric-card__foot"><small>{detail ?? 'Periodo seleccionado'}</small></div></div>
}

function PaymentTable({ payments, loading, onOpenPayment, title }: { payments: Payment[]; loading: boolean; onOpenPayment: (payment: Payment) => void; title: string }) {
  return <section className="panel operations-table"><div className="panel-title-row"><div><h2>{title}</h2><p>{loading ? 'Consultando ledger…' : `${payments.length} operaciones encontradas`}</p></div></div><div className="table-wrap"><table><thead><tr><th>OPERACIÓN</th><th>FECHA Y HORA</th><th>MÉTODO</th><th>CAJERO</th><th>MONTO</th><th>ESTADO</th></tr></thead><tbody>{payments.map((payment) => <tr key={payment.id} onClick={() => payment.status === 'PENDING' && onOpenPayment(payment)}><td><span className="reference-cell"><span className={`reference-icon ${payment.method === 'CASH' ? 'reference-icon--cash' : ''}`}>{payment.method === 'CASH' ? <CashIcon size={15} /> : <QrIcon size={15} />}</span><span><strong>{payment.reference}</strong><small>{payment.method === 'CASH' ? 'Registro en caja' : 'QR dinámico'}</small></span></span></td><td><span className="date-cell">{formatDateTime(payment.createdAt)}</span></td><td><span className={`method-tag ${payment.method === 'CASH' ? 'method-tag--cash' : ''}`}><i />{payment.method === 'CASH' ? 'Efectivo' : 'Digital'}</span></td><td><span className="cashier-cell"><span className="avatar avatar--tiny">{initials(payment.createdBy)}</span>{payment.createdBy}</span></td><td><strong className="amount-cell">{formatSoles(payment.amountCents)}</strong></td><td><span className={`status-tag status-tag--${payment.status.toLowerCase()}`}><i />{statusLabels[payment.status]}</span></td></tr>)}</tbody></table>{!loading && payments.length === 0 && <div className="empty-state"><ReceiptIcon size={26} /><strong>No hay operaciones con estos filtros</strong><small>Prueba ajustando tu búsqueda o el periodo.</small></div>}</div><div className="table-footer"><span>Mostrando <strong>{payments.length}</strong> operaciones</span></div></section>
}

function MethodBars({ total, digital, cash }: { total: number; digital: number; cash: number }) {
  return <div className="method-bars"><div><div className="bar-label"><span><i className="legend-dot" /> Digital</span><strong>{formatSoles(digital)}</strong></div><div className="bar-track"><span style={{ width: `${total ? Math.min(100, digital / total * 100) : 0}%` }} /></div></div><div><div className="bar-label"><span><i className="legend-dot legend-dot--cash" /> Efectivo</span><strong>{formatSoles(cash)}</strong></div><div className="bar-track bar-track--cash"><span style={{ width: `${total ? Math.min(100, cash / total * 100) : 0}%` }} /></div></div></div>
}

function parseSolesFilter(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (!/^\d+(?:\.\d{1,2})?$/.test(trimmed)) return null
  const [whole, decimals = ''] = trimmed.split('.')
  const amount = Number(whole) * 100 + Number(decimals.padEnd(2, '0'))
  return Number.isSafeInteger(amount) ? amount : null
}

function localDateValue(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function dateInputToIso(value: string, end: boolean): string | undefined {
  if (!value) return undefined
  const date = new Date(`${value}T${end ? '23:59:59.999' : '00:00:00.000'}`)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

function searchablePaymentText(payment: Payment): string {
  return `${payment.reference} ${payment.createdBy} ${payment.amountCents} ${(payment.amountCents / 100).toFixed(2)}`.toLowerCase()
}

function initials(value: string): string {
  return value.split(/\s+/).filter(Boolean).map((item) => item[0]).join('').slice(0, 2).toUpperCase()
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' })
}

function InfoIconFallback() {
  return <span aria-hidden="true">ⓘ</span>
}
