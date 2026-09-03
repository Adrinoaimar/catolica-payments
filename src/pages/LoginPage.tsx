import { useState } from 'react'
import { ArrowIcon, CheckIcon, InfoIcon } from '../components/Icons'
import { BrandMark } from '../components/BrandMark'
import type { SessionUser } from '../types'

interface LoginPageProps { onLogin: (user: SessionUser) => void }

export function LoginPage({ onLogin }: LoginPageProps) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!email || !password) { setError('Ingresa tu correo y contraseña para continuar.'); return }
    onLogin({ id: 'cashier-demo', name: email.split('@')[0] ? email.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, (match) => match.toUpperCase()) : 'María González', email, role: email.includes('admin') ? 'ADMIN' : 'CASHIER', initials: (email.split('@')[0] || 'mg').split(/[._]/).map((part) => part[0]).join('').slice(0, 2).toUpperCase() })
  }

  return (
    <main className="login-shell">
      <section className="login-brand-panel">
        <div className="login-brand-inner">
          <BrandMark />
          <div className="login-hero-copy">
            <div className="eyebrow eyebrow--light"><span className="eyebrow-dot" /> PLATAFORMA DE COBROS</div>
            <h1>Cobra fácil.<br /><span>Crece juntos.</span></h1>
            <p>La forma más simple de gestionar los pagos de tu institución.</p>
            <div className="login-benefits">
              <div><span><CheckIcon size={14} /></span><p><strong>Cobros rápidos</strong><small>Genera un QR en segundos</small></p></div>
              <div><span><CheckIcon size={14} /></span><p><strong>Control total</strong><small>Visualiza cada pago en un solo lugar</small></p></div>
              <div><span><CheckIcon size={14} /></span><p><strong>Siempre seguro</strong><small>Confirmación validada por el sistema</small></p></div>
            </div>
          </div>
          <div className="login-panel-footer"><span>© 2026 Grupo La Católica</span><span>Soporte</span></div>
        </div>
        <div className="login-orb login-orb--one" /><div className="login-orb login-orb--two" />
      </section>
      <section className="login-form-panel">
        <div className="login-form-wrap">
          <div className="mobile-login-logo"><BrandMark /></div>
          <div className="login-heading"><div className="eyebrow">ACCESO AL SISTEMA</div><h2>Bienvenido de vuelta</h2><p>Ingresa tus datos para acceder a tu panel.</p></div>
          <form className="login-form" onSubmit={handleSubmit}>
            <label htmlFor="email">Correo electrónico<input id="email" type="email" autoComplete="email" placeholder="nombre@grupolacatolica.edu.pe" value={email} onChange={(event) => { setEmail(event.target.value); setError('') }} /></label>
            <label htmlFor="password">Contraseña<div className="password-wrap"><input id="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" placeholder="Ingresa tu contraseña" value={password} onChange={(event) => { setPassword(event.target.value); setError('') }} /><button type="button" className="password-toggle" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}>{showPassword ? 'Ocultar' : 'Mostrar'}</button></div></label>
            <div className="login-form-meta"><label className="remember-check"><input type="checkbox" defaultChecked /><span>Recordarme</span></label><button className="text-button" type="button">¿Olvidaste tu contraseña?</button></div>
            {error && <div className="form-error"><InfoIcon size={16} /> {error}</div>}
            <button className="primary-button primary-button--large" type="submit">Ingresar <ArrowIcon size={18} /></button>
          </form>
          <div className="login-help"><span>¿Necesitas ayuda?</span> <button className="text-button" type="button">Contactar a soporte</button></div>
          <div className="demo-hint"><span className="demo-hint__dot" /><p><strong>Modo demo disponible</strong><small>Usa cualquier correo y contraseña para explorar.</small></p></div>
        </div>
      </section>
    </main>
  )
}
