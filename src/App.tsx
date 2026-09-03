import { useEffect, useState } from 'react'
import { Sidebar, type AppSection } from './components/Sidebar'
import { MenuIcon, PlusIcon, SearchIcon, DownloadIcon, FilterIcon, ArrowIcon, CheckIcon, ClockIcon, QrIcon, CashIcon, ChartIcon, InfoIcon } from './components/Icons'
import { BrandMark } from './components/BrandMark'
import { LoginPage } from './pages/LoginPage'
import { CashierPage } from './pages/CashierPage'
import { BackOfficePage } from './pages/BackOfficePage'
import { AdminSettingsPage } from './pages/AdminSettingsPage'
import { PaymentPage } from './pages/PaymentPage'
import { listPayments, loadPayments, savePayments, simulateMockPayment } from './lib/demoStore'
import { formatSoles } from './lib/format'
import type { Payment, SessionUser } from './types'
import { AuthProvider, useAuth } from './lib/auth'
import { isDemoMode } from './lib/supabase'
import { fetchPublicPayment, subscribeToPayments } from './lib/realtime'
import { mergePayment, mergePaymentSnapshot } from './lib/paymentMerge'
import './styles.css'

function App() {
  const { user, loading: authLoading, error: authError, signIn, signOut, resetPassword } = useAuth()
  const [section, setSection] = useState<AppSection>('cashier')
  const [payments, setPayments] = useState<Payment[]>(() => loadPayments())
  const [activePayment, setActivePayment] = useState<Payment | null>(null)
  const [ledgerError, setLedgerError] = useState<string | null>(null)
  const [realtimeHealthy, setRealtimeHealthy] = useState(false)
  const [mobileMenu, setMobileMenu] = useState(false)
  const [path, setPath] = useState(() => window.location.pathname)
  const userId = user?.id
  useEffect(() => { const sync = () => { const next = loadPayments(); setPayments((current) => mergePaymentSnapshot(current, next)); setActivePayment((current) => { if (!current) return current; const nextPayment = next.find((item) => item.reference === current.reference); return nextPayment ? mergePayment(current, nextPayment) : current }); }; window.addEventListener('catolica:payments-updated', sync); window.addEventListener('storage', sync); return () => { window.removeEventListener('catolica:payments-updated', sync); window.removeEventListener('storage', sync) } }, [])
  useEffect(() => { const syncPath = () => setPath(window.location.pathname); window.addEventListener('popstate', syncPath); return () => window.removeEventListener('popstate', syncPath) }, [])
  useEffect(() => {
    if (!user || path !== '/login') return
    window.history.replaceState({}, '', '/')
    setPath('/')
  }, [user, path])
  useEffect(() => {
    if (!userId) { setPayments(loadPayments()); setLedgerError(null); setRealtimeHealthy(false); return }
    let active = true
    void listPayments().then((next) => {
      if (!active) return
      setPayments((current) => mergePaymentSnapshot(current, next))
      setLedgerError(null)
    }).catch((reason) => {
      if (!active) return
      setLedgerError(reason instanceof Error ? reason.message : 'No se pudieron cargar las operaciones.')
    })
    return () => { active = false }
  }, [userId])
  useEffect(() => {
    if (!userId || isDemoMode) { setRealtimeHealthy(false); return }
    let active = true
    const unsubscribe = subscribeToPayments({
      userId,
      onChange: (change) => {
        if (!active) return
        if (change.event === 'DELETE') {
          setPayments((current) => current.filter((item) => item.id !== change.id && item.reference !== change.reference))
          setActivePayment((current) => current && (current.id === change.id || current.reference === change.reference) ? null : current)
          return
        }
        if (!change.reference) return
        void fetchPublicPayment(change.reference).then((next) => {
          if (!active) return
          setPayments((current) => upsertPayment(current, next))
          setActivePayment((current) => current && current.reference === next.reference ? mergePayment(current, next) : current)
        }).catch(() => {
          // The API polling path remains authoritative if a transient stream
          // event races the transaction's read replica.
        })
      },
      onStatus: (status, error) => {
        if (!active) return
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          setRealtimeHealthy(false)
          setLedgerError(error?.message || 'Actualización en tiempo real no disponible. Se reintentará automáticamente.')
        } else if (status === 'SUBSCRIBED') {
          setRealtimeHealthy(true)
          setLedgerError((current) => current?.startsWith('Actualización en tiempo real') ? null : current)
          // Reconcile after every reconnect. Realtime does not replay rows
          // missed while the browser was offline.
          void listPayments().then((next) => {
            if (!active) return
            setPayments((current) => mergePaymentSnapshot(current, next))
            setActivePayment((current) => {
              if (!current) return current
              const nextPayment = next.find((item) => item.reference === current.reference)
              return nextPayment ? mergePayment(current, nextPayment) : current
            })
          }).catch(() => { /* current snapshot remains until next event */ })
        } else if (status === 'CLOSED') {
          setRealtimeHealthy(false)
          setLedgerError('Actualización en tiempo real cerrada. Se mantiene sincronización de respaldo.')
        }
      },
    })
    return () => { active = false; unsubscribe() }
  }, [userId])
  useEffect(() => {
    if (!userId || isDemoMode) return
    // Realtime is the primary channel. This bounded fallback keeps dashboard
    // and operations current during reconnects or provider/network outages.
    const interval = window.setInterval(() => {
      if (realtimeHealthy) return
      void listPayments().then((next) => {
        setPayments((current) => mergePaymentSnapshot(current, next))
        setActivePayment((current) => {
          if (!current) return current
          const nextPayment = next.find((item) => item.reference === current.reference)
          return nextPayment ? mergePayment(current, nextPayment) : current
        })
      }).catch(() => { /* the next interval retries without replacing the snapshot */ })
    }, 15000)
    return () => window.clearInterval(interval)
  }, [userId, realtimeHealthy])
  useEffect(() => {
    if (!userId || isDemoMode) return
    let active = true
    const resync = () => {
      void listPayments().then((next) => {
        if (!active) return
        setPayments((current) => mergePaymentSnapshot(current, next))
        setActivePayment((current) => {
          if (!current) return current
          const nextPayment = next.find((item) => item.reference === current.reference)
          return nextPayment ? mergePayment(current, nextPayment) : current
        })
      }).catch(() => { /* transient focus/network failure; next event or focus retries */ })
    }
    const onPageShow = () => resync()
    const onVisibilityChange = () => { if (document.visibilityState === 'visible') resync() }
    window.addEventListener('pageshow', onPageShow)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      active = false
      window.removeEventListener('pageshow', onPageShow)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [userId])
  const paidPayment = (payment: Payment) => { setActivePayment((current) => current ? mergePayment(current, payment) : payment); setPayments((current) => { const next = upsertPayment(current, payment); savePayments(next); return next }) }
  const simulatorReference = isDemoMode ? path.match(/^\/dev\/mock-payment\/([^/]+)/)?.[1] : undefined
  if (simulatorReference) return <MockSimulator reference={decodeURIComponent(simulatorReference)} payments={payments} onComplete={(payment) => { paidPayment(payment); window.history.pushState({}, '', '/'); setPath('/') }} />
  if (authLoading) return <div className="login-shell"><div className="login-form-panel"><div className="login-form-wrap"><div className="eyebrow">ACCESO AL SISTEMA</div><h2>Validando sesión…</h2></div></div></div>
  if (!user) return <LoginPage onLogin={async (email, password) => { const next = await signIn(email, password); setSection('cashier'); return next }} authError={authError} demoMode={isDemoMode} onResetPassword={resetPassword} />

  const create = (payment: Payment) => { setPayments((current) => [payment, ...current.filter((item) => item.id !== payment.id)]); setActivePayment(payment) }
  const logout = () => { void signOut().finally(() => setActivePayment(null)) }
  const newCharge = () => { setActivePayment(null); setSection('cashier') }
  const cancelledPayment = (payment: Payment) => {
    setPayments((current) => upsertPayment(current, payment))
    setActivePayment((current) => current ? mergePayment(current, payment) : payment)
  }

   const sectionLabel = activePayment ? 'Cobro digital' : section === 'cashier' ? 'Punto de cobro' : section === 'dashboard' ? 'Resumen general' : section === 'operations' ? 'Operaciones' : section === 'settings' ? 'Administración' : 'Reportes'
   return <div className="app-shell"><Sidebar user={user} section={section} onNavigate={(next) => { setSection(next); setActivePayment(null) }} onLogout={logout} open={mobileMenu} onClose={() => setMobileMenu(false)} />
     <div className="main-shell"><header className="topbar"><button className="mobile-menu" aria-label="Abrir menú" onClick={() => setMobileMenu(true)}><MenuIcon size={22} /></button><div className="topbar-title"><span className="topbar-kicker">GRUPO LA CATÓLICA</span><span className="topbar-context">/ {sectionLabel}</span></div><div className="topbar-actions"><button className="icon-button topbar-search" aria-label="Buscar"><SearchIcon size={19} /></button><span className="topbar-divider" /><span className="avatar">{user.initials}</span><span className="topbar-user"><strong>{user.name}</strong><small>{user.role === 'ADMIN' ? 'Administrador' : 'Cajero'}</small></span></div></header><main className="content-shell">{ledgerError && <div className="form-error" role="alert"><InfoIcon size={16} /> {ledgerError}</div>}{activePayment ? <PaymentPage payment={activePayment} onPaid={paidPayment} onCancelled={cancelledPayment} canCancel={user.role === 'ADMIN'} onNew={newCharge} demoMode={isDemoMode} onSimulator={(payment) => { const popup = window.open(`/dev/mock-payment/${payment.reference}`, '_blank', 'noopener,noreferrer'); if (!popup) { window.history.pushState({}, '', `/dev/mock-payment/${payment.reference}`); window.dispatchEvent(new PopStateEvent('popstate')) } }} /> : section === 'cashier' ? <CashierPage user={user} onCreated={create} /> : section === 'settings' ? <AdminSettingsPage user={user} onNew={newCharge} /> : <BackOfficePage section={section} payments={payments} user={user} onNew={newCharge} onOpenPayment={setActivePayment} />}</main></div></div>
}

function upsertPayment(current: Payment[], next: Payment): Payment[] {
  const index = current.findIndex((item) => item.id === next.id || item.reference === next.reference)
  if (index < 0) return [next, ...current]
  const previous = current[index]
  const merged = mergePayment(previous, next)
  return current.map((item, itemIndex) => itemIndex === index ? merged : item)
}

function MockSimulator({ reference, payments, onComplete }: { reference: string; payments: Payment[]; onComplete: (payment: Payment) => void }) {
  const payment = payments.find((item) => item.reference === reference)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(payment?.status === 'PAID')
  if (!payment) return <div className="simulator-shell"><div className="simulator-card-large"><BrandMark /><h1>Operación no encontrada</h1><p>La referencia no existe o ya no está disponible.</p><a className="primary-button" href="/">Volver a la caja</a></div></div>
  async function pay() { if (!payment) return; setBusy(true); const result = await simulateMockPayment(payment); setDone(true); onComplete(result); setBusy(false) }
  return <div className="simulator-shell"><div className="simulator-card-large"><div className="simulator-header"><BrandMark /><span className="demo-chip">MODO DEMO</span></div><div className="eyebrow">SIMULADOR DE PAGO</div><h1>Confirma tu pago</h1><p className="simulator-subtitle">Esta pantalla representa la billetera digital del cliente.</p><div className="simulator-amount">{formatSoles(payment.amountCents)}</div><div className="simulator-meta"><div><span>Operación</span><strong>{payment.reference}</strong></div><div><span>Concepto</span><strong>Grupo La Católica</strong></div></div>{done ? <div className="simulator-done"><span><CheckIcon size={25} /></span><div><strong>Pago enviado</strong><small>El webhook fue recibido. Puedes volver a la caja.</small></div></div> : <button className="primary-button primary-button--large" disabled={busy} onClick={pay}>{busy ? 'Enviando evento…' : <>Simular pago exitoso <ArrowIcon size={18} /></>}</button>}<a className="simulator-back" href="/">Cerrar simulador</a></div></div>
}

function BackOffice({ section, payments, user, onNew }: { section: AppSection; payments: Payment[]; user: SessionUser; onNew: () => void }) {
  const paid = payments.filter((item) => item.status === 'PAID'); const digital = paid.filter((item) => item.method === 'DIGITAL'); const cash = paid.filter((item) => item.method === 'CASH'); const pending = payments.filter((item) => item.status === 'PENDING'); const total = paid.reduce((sum, item) => sum + item.amountCents, 0)
  const [query, setQuery] = useState(''); const [method, setMethod] = useState('ALL')
  const filtered = payments.filter((item) => (!query || item.reference.toLowerCase().includes(query.toLowerCase()) || item.createdBy.toLowerCase().includes(query.toLowerCase())) && (method === 'ALL' || item.method === method))
  if (section === 'reports') return <div className="page-stack"><div className="page-heading"><div><div className="eyebrow">ANÁLISIS</div><h1>Reportes</h1><p>Resumen exportable de actividad financiera.</p></div><button className="secondary-button"><DownloadIcon size={16} /> Exportar CSV</button></div><div className="report-grid"><ReportCard label="Ventas del mes" value={formatSoles(total)} detail="Total recaudado" /><ReportCard label="Operaciones" value={String(payments.length)} detail={`${pending.length} pendientes`} /><ReportCard label="Tasa de éxito" value={`${payments.length ? Math.round(paid.length / payments.length * 100) : 0}%`} detail="Pagos confirmados" /></div><div className="panel report-panel"><div className="panel-title-row"><div><h2>Distribución por método</h2><p>Comparativa del periodo seleccionado</p></div><span className="period-select">Este mes⌄</span></div><div className="method-bars"><div><div className="bar-label"><span><i className="legend-dot legend-dot--digital" /> Digital</span><strong>{formatSoles(digital.reduce((s, p) => s + p.amountCents, 0))}</strong></div><div className="bar-track"><span style={{ width: `${total ? digital.reduce((s, p) => s + p.amountCents, 0) / total * 100 : 0}%` }} /></div></div><div><div className="bar-label"><span><i className="legend-dot legend-dot--cash" /> Efectivo</span><strong>{formatSoles(cash.reduce((s, p) => s + p.amountCents, 0))}</strong></div><div className="bar-track bar-track--cash"><span style={{ width: `${total ? cash.reduce((s, p) => s + p.amountCents, 0) / total * 100 : 0}%` }} /></div></div></div></div></div>
  if (section === 'dashboard') return <Dashboard payments={payments} total={total} digital={digital} cash={cash} pending={pending} onNew={onNew} />
  return <div className="page-stack"><div className="page-heading"><div><div className="eyebrow">CONTROL FINANCIERO</div><h1>Operaciones</h1><p>Consulta y filtra cada cobro registrado.</p></div><button className="primary-button" onClick={onNew}><PlusIcon size={17} /> Nuevo cobro</button></div><div className="toolbar panel"><div className="search-field"><SearchIcon size={17} /><input placeholder="Buscar referencia o cajero" value={query} onChange={(e) => setQuery(e.target.value)} /></div><select value={method} onChange={(e) => setMethod(e.target.value)}><option value="ALL">Todos los métodos</option><option value="DIGITAL">Digital</option><option value="CASH">Efectivo</option></select><button className="secondary-button toolbar-filter"><FilterIcon size={16} /> Filtros</button></div><div className="panel operations-table"><div className="table-head"><span>Operación</span><span>Monto</span><span>Método</span><span>Estado</span><span>Cajero</span><span>Hora</span></div>{filtered.map((payment) => <OperationRow key={payment.id} payment={payment} />)}{filtered.length === 0 && <div className="empty-state">No hay operaciones que coincidan.</div>}</div></div>
}

function Dashboard({ payments, total, digital, cash, pending, onNew }: { payments: Payment[]; total: number; digital: Payment[]; cash: Payment[]; pending: Payment[]; onNew: () => void }) { return <div className="page-stack"><div className="page-heading"><div><div className="eyebrow">MIÉRCOLES, 02 DE SEPTIEMBRE</div><h1>Resumen del día</h1><p>Así se mueve tu caja hoy.</p></div><button className="primary-button" onClick={onNew}><PlusIcon size={17} /> Nuevo cobro</button></div><div className="metrics-grid"><MetricCard label="Ventas hoy" value={formatSoles(total)} detail="vs. periodo anterior" trend="+12.8%" accent="blue" /><MetricCard label="Pagos digitales" value={formatSoles(digital.reduce((s, p) => s + p.amountCents, 0))} detail={`${digital.length} operaciones`} accent="violet" icon={<QrIcon size={17} />} /><MetricCard label="Efectivo" value={formatSoles(cash.reduce((s, p) => s + p.amountCents, 0))} detail={`${cash.length} operaciones`} accent="amber" icon={<CashIcon size={17} />} /><MetricCard label="Pendientes" value={String(pending.length).padStart(2, '0')} detail="Esperando confirmación" accent="green" icon={<ClockIcon size={17} />} /></div><div className="dashboard-grid"><div className="panel activity-panel"><div className="panel-title-row"><div><h2>Últimas operaciones</h2><p>Actividad reciente de tu institución</p></div><button className="text-button">Ver todas <ArrowIcon size={14} /></button></div><div className="activity-list">{payments.slice(0, 5).map((payment) => <OperationRow key={payment.id} payment={payment} compact />)}</div></div><div className="panel volume-panel"><div className="panel-title-row"><div><h2>Volumen de ventas</h2><p>Últimos 7 días</p></div><ChartIcon size={19} /></div><div className="chart-placeholder"><div className="chart-grid-lines"><i /><i /><i /><i /></div><svg viewBox="0 0 500 150" preserveAspectRatio="none" aria-label="Gráfico de ventas"><defs><linearGradient id="chartFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#2563eb" stopOpacity=".22" /><stop offset="1" stopColor="#2563eb" stopOpacity="0" /></linearGradient></defs><path d="M0 125 C50 120 65 88 105 96 S160 112 200 62 S260 88 295 71 S355 75 390 45 S450 66 500 18 V150 H0Z" fill="url(#chartFill)" /><path d="M0 125 C50 120 65 88 105 96 S160 112 200 62 S260 88 295 71 S355 75 390 45 S450 66 500 18" fill="none" stroke="#2563eb" strokeWidth="3" /></svg><div className="chart-labels"><span>Lun</span><span>Mar</span><span>Mié</span><span>Jue</span><span>Vie</span><span>Sáb</span><span>Dom</span></div></div></div></div></div> }

function MetricCard({ label, value, detail, trend, accent, icon }: { label: string; value: string; detail: string; trend?: string; accent: string; icon?: React.ReactNode }) { return <div className={`metric-card metric-card--${accent}`}><div className="metric-card__head"><span>{label}</span>{icon ?? <span className="metric-icon">S/</span>}</div><strong>{value}</strong><div className="metric-card__foot"><small>{detail}</small>{trend && <em>{trend}</em>}</div></div> }
function ReportCard({ label, value, detail }: { label: string; value: string; detail: string }) { return <div className="report-card"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div> }
function OperationRow({ payment, compact = false }: { payment: Payment; compact?: boolean }) { return <div className={`operation-row-table ${compact ? 'operation-row-table--compact' : ''}`}><div className="operation-ref"><span className={`operation-method-icon ${payment.method === 'CASH' ? 'operation-method-icon--cash' : ''}`}>{payment.method === 'CASH' ? <CashIcon size={15} /> : <QrIcon size={15} />}</span><span><strong>{payment.reference}</strong><small>{payment.method === 'CASH' ? 'Pago en efectivo' : 'Pago digital'}</small></span></div><strong className="operation-amount">{formatSoles(payment.amountCents)}</strong><span className="method-label">{payment.method === 'CASH' ? 'Efectivo' : 'Digital'}</span><span className={`status-badge status-badge--${payment.status.toLowerCase()}`}><i />{payment.status === 'PAID' ? 'Pagado' : payment.status === 'PENDING' ? 'Pendiente' : payment.status}</span><span className="operation-cashier">{payment.createdBy}</span><span className="operation-time">{new Date(payment.createdAt).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })}</span></div> }

export default function AppWithAuth() { return <AuthProvider><App /></AuthProvider> }
