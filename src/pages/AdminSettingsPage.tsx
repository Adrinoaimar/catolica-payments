import { useEffect, useState } from 'react'
import { InfoIcon, PlusIcon, SettingsIcon } from '../components/Icons'
import { inviteManagedUser, listAdminQuickAmounts, listManagedUsers, saveAdminQuickAmounts, updateManagedUserRole, type ManagedRole, type ManagedUser } from '../lib/admin'
import { DEFAULT_QUICK_AMOUNTS } from '../lib/quickAmounts'
import type { SessionUser } from '../types'

interface AdminSettingsPageProps {
  user: SessionUser
  onNew: () => void
}

export function AdminSettingsPage({ user, onNew }: AdminSettingsPageProps) {
  const [users, setUsers] = useState<ManagedUser[]>([])
  const [amountInputs, setAmountInputs] = useState(() => DEFAULT_QUICK_AMOUNTS.map(centsToInput))
  const [loading, setLoading] = useState(true)
  const [savingAmounts, setSavingAmounts] = useState(false)
  const [busyUser, setBusyUser] = useState('')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<ManagedRole>('CASHIER')
  const [inviteBusy, setInviteBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    setLoading(true)
    void Promise.all([listManagedUsers(), listAdminQuickAmounts()]).then(([nextUsers, nextAmounts]) => {
      if (!active) return
      setUsers(nextUsers)
      setAmountInputs(nextAmounts.map((item) => centsToInput(item.amountCents)))
      setError('')
    }).catch((reason) => {
      if (!active) return
      setError(reason instanceof Error ? reason.message : 'No se pudo cargar la administración.')
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  async function invite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inviteBusy) return
    setInviteBusy(true)
    setError('')
    setMessage('')
    try {
      const invited = await inviteManagedUser({ email, name, role })
      setUsers((current) => [invited, ...current.filter((item) => item.id !== invited.id)])
      setEmail('')
      setName('')
      setRole('CASHIER')
      setMessage('Invitación enviada. El usuario recibirá un correo para activar su acceso.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo invitar al usuario.')
    } finally { setInviteBusy(false) }
  }

  async function changeRole(target: ManagedUser, nextRole: ManagedRole) {
    if (busyUser || target.role === nextRole) return
    setBusyUser(target.id)
    setError('')
    setMessage('')
    try {
      const updated = await updateManagedUserRole(target.id, nextRole)
      setUsers((current) => current.map((item) => item.id === updated.id ? updated : item))
      setMessage('Rol de ' + updated.name + ' actualizado.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo actualizar el rol.')
    } finally { setBusyUser('') }
  }

  function addAmount() {
    if (amountInputs.length >= 12) return
    setAmountInputs((current) => [...current, ''])
  }

  function removeAmount(index: number) {
    setAmountInputs((current) => current.filter((_, itemIndex) => itemIndex !== index))
  }

  async function saveAmounts() {
    setError('')
    setMessage('')
    const parsed = amountInputs.map(parseSolesInput)
    if (parsed.some((amount) => amount === null)) {
      setError('Cada monto debe usar soles con hasta dos decimales.')
      return
    }
    const amounts = parsed as number[]
    if (amounts.length < 1 || amounts.length > 12 || new Set(amounts).size !== amounts.length) {
      setError('Configura entre 1 y 12 montos rápidos sin repetir.')
      return
    }
    setSavingAmounts(true)
    try {
      const saved = await saveAdminQuickAmounts(amounts)
      setAmountInputs(saved.map((item) => centsToInput(item.amountCents)))
      setMessage('Montos rápidos guardados. Se aplican en la próxima cobranza de cada caja.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudieron guardar los montos rápidos.')
    } finally { setSavingAmounts(false) }
  }

  return <div className="page-stack admin-settings-page">
    <div className="page-heading"><div><div className="eyebrow">ADMINISTRACIÓN</div><h1>Usuarios y configuración</h1><p>Gestiona accesos y montos sugeridos para toda la institución.</p></div><button className="primary-button" onClick={onNew}><PlusIcon size={17} /> Nuevo cobro</button></div>
    {(error || message) && <div className={error ? 'form-error' : 'form-note'} role={error ? 'alert' : 'status'}><InfoIcon size={16} /> {error || message}</div>}
    {loading ? <div className="panel settings-loading" role="status">Cargando configuración…</div> : <div className="settings-grid">
      <section className="panel settings-card"><div className="settings-card__heading"><span className="settings-card__icon"><SettingsIcon size={18} /></span><div><h2>Usuarios y roles</h2><p>Solo ADMIN puede modificar permisos o invitar usuarios.</p></div></div>
        <form className="settings-invite-form" onSubmit={invite}><div className="settings-form-field"><label htmlFor="invite-name">Nombre completo</label><input id="invite-name" required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} placeholder="Nombre del usuario" /></div><div className="settings-form-field"><label htmlFor="invite-email">Correo institucional</label><input id="invite-email" required type="email" maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="persona@institucion.edu.pe" /></div><div className="settings-form-field"><label htmlFor="invite-role">Rol inicial</label><select id="invite-role" value={role} onChange={(event) => setRole(event.target.value as ManagedRole)}><option value="CASHIER">Cajero</option><option value="ADMIN">Administrador</option></select></div><button className="secondary-button" type="submit" disabled={inviteBusy}>{inviteBusy ? 'Enviando…' : 'Invitar usuario'}</button></form>
        <div className="table-wrap settings-table-wrap"><table><thead><tr><th>USUARIO</th><th>ROL</th><th>ESTADO</th><th>ÚLTIMO ACCESO</th></tr></thead><tbody>{users.map((item) => <tr key={item.id}><td><span className="settings-user-cell"><span className="avatar avatar--tiny">{initials(item.name)}</span><span><strong>{item.name}</strong><small>{item.email}</small></span></span></td><td><select aria-label={'Rol de ' + item.name} value={item.role ?? ''} disabled={busyUser === item.id || !item.role || item.id === user.id} onChange={(event) => void changeRole(item, event.target.value as ManagedRole)}><option value="" disabled>Sin rol</option><option value="CASHIER">Cajero</option><option value="ADMIN">Administrador</option></select></td><td><span className={'settings-status settings-status--' + item.status.toLowerCase()}>{statusLabel(item.status)}</span></td><td>{item.lastSignInAt ? formatDate(item.lastSignInAt) : 'Sin acceso'}</td></tr>)}</tbody></table>{users.length === 0 && <div className="empty-state">No hay usuarios administrables.</div>}</div>
      </section>
      <section className="panel settings-card"><div className="settings-card__heading"><span className="settings-card__icon"><span className="settings-currency">S/</span></span><div><h2>Montos rápidos</h2><p>Orden de botones mostrado en Nueva cobranza. Máximo 12.</p></div></div><div className="quick-settings-list">{amountInputs.map((value, index) => <div className="quick-settings-row" key={'quick-' + index}><span className="quick-settings-index">{String(index + 1).padStart(2, '0')}</span><label className="sr-only" htmlFor={'quick-amount-' + index}>Monto rápido {index + 1} en soles</label><div className="quick-settings-input"><span>S/</span><input id={'quick-amount-' + index} inputMode="decimal" value={value} onChange={(event) => setAmountInputs((current) => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} /><span>PEN</span></div><button type="button" className="text-button settings-remove-button" onClick={() => removeAmount(index)} disabled={amountInputs.length <= 1} aria-label={'Quitar monto ' + (index + 1)}>Quitar</button></div>)}</div><div className="settings-actions"><button type="button" className="secondary-button" onClick={addAmount} disabled={amountInputs.length >= 12}><PlusIcon size={15} /> Añadir monto</button><button type="button" className="primary-button" onClick={() => void saveAmounts()} disabled={savingAmounts}>{savingAmounts ? 'Guardando…' : 'Guardar montos'}</button></div><p className="settings-help">Los montos se guardan en centavos enteros y se aplican igual para pagos digitales y efectivo.</p></section>
    </div>}
  </div>
}

function parseSolesInput(value: string): number | null {
  const normalized = value.trim().replace(',', '.')
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null
  const [whole, decimals = ''] = normalized.split('.')
  const amount = Number(whole) * 100 + Number(decimals.padEnd(2, '0'))
  return Number.isSafeInteger(amount) && amount > 0 && amount <= 1_000_000 ? amount : null
}

function centsToInput(amountCents: number): string {
  return Math.floor(amountCents / 100) + '.' + String(amountCents % 100).padStart(2, '0')
}

function initials(value: string): string {
  return value.split(/\s+/).filter(Boolean).map((item) => item[0]).join('').slice(0, 2).toUpperCase()
}

function statusLabel(value: ManagedUser['status']): string {
  return value === 'ACTIVE' ? 'Activo' : value === 'INVITED' ? 'Invitado' : 'Suspendido'
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' })
}
