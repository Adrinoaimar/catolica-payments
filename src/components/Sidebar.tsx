import { BrandMark } from './BrandMark'
import { BellIcon, CashIcon, ChartIcon, GridIcon, LogOutIcon, ReceiptIcon, SettingsIcon, CloseIcon } from './Icons'
import type { SessionUser } from '../types'

export type AppSection = 'cashier' | 'dashboard' | 'operations' | 'reports' | 'settings'
interface SidebarProps { user: SessionUser; section: AppSection; onNavigate: (section: AppSection) => void; onLogout: () => void; open?: boolean; onClose?: () => void }

export function Sidebar({ user, section, onNavigate, onLogout, open = false, onClose }: SidebarProps) {
  const links: { key: AppSection; label: string; icon: typeof GridIcon }[] = [
    { key: 'cashier', label: 'Nueva cobranza', icon: CashIcon },
    { key: 'dashboard', label: 'Resumen', icon: GridIcon },
    { key: 'operations', label: 'Operaciones', icon: ReceiptIcon },
    { key: 'reports', label: 'Reportes', icon: ChartIcon },
  ]
  const visibleLinks = user.role === 'ADMIN' ? links : links.filter(({ key }) => key !== 'reports')
  return <>
    {open && <button className="sidebar-overlay" aria-label="Cerrar menú" onClick={onClose} />}
    <aside className={`sidebar ${open ? 'sidebar--open' : ''}`}>
      <div className="sidebar-top"><BrandMark /><button className="sidebar-close" onClick={onClose} aria-label="Cerrar menú"><CloseIcon size={20} /></button></div>
      <div className="sidebar-section-label">MENÚ PRINCIPAL</div>
      <nav className="sidebar-nav">{visibleLinks.map(({ key, label, icon: Icon }) => <button key={key} className={`sidebar-link ${section === key ? 'sidebar-link--active' : ''}`} onClick={() => { onNavigate(key); onClose?.() }}><Icon size={19} /><span>{label}</span>{key === 'cashier' && <i className="sidebar-link__new">+ Nuevo</i>}</button>)}</nav>
      <div className="sidebar-divider" />
      <div className="sidebar-section-label">CONFIGURACIÓN</div>
      <nav className="sidebar-nav">{user.role === 'ADMIN' && <button className={'sidebar-link ' + (section === 'settings' ? 'sidebar-link--active' : '')} onClick={() => { onNavigate('settings'); onClose?.() }}><SettingsIcon size={19} /><span>Administración</span></button>}<button className="sidebar-link"><BellIcon size={19} /><span>Notificaciones</span><b className="notification-count">2</b></button></nav>
      <div className="sidebar-bottom"><div className="sidebar-user"><span className="avatar avatar--sidebar">{user.initials}</span><span className="sidebar-user-copy"><strong>{user.name}</strong><small>{user.role === 'ADMIN' ? 'Administrador' : 'Cajero'}</small></span><button className="icon-button icon-button--muted" onClick={onLogout} aria-label="Cerrar sesión"><LogOutIcon size={17} /></button></div><div className="sidebar-status"><span className="status-dot status-dot--green" /> Sistema operativo</div></div>
    </aside>
  </>
}
