import { useState } from 'react'
import { ArrowIcon, CheckIcon, InfoIcon } from '../components/Icons'
import { BrandMark } from '../components/BrandMark'
import type { SessionUser } from '../types'

interface LoginPageProps {
  onLogin: (email: string, password: string) => Promise<SessionUser>
  authError?: string | null
  demoMode?: boolean
  onResetPassword?: (email: string) => Promise<void>
}

export function LoginPage({ onLogin, authError, demoMode = false, onResetPassword }: LoginPageProps) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!email || !password) { setError('Ingresa tu correo y contraseña para continuar.'); return }
    setBusy(true)
    setError('')
    try { await onLogin(email, password) } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudo iniciar sesión.') }
    finally { setBusy(false) }
  }

  async function handleResetPassword() {
    if (!onResetPassword) { setError('Solicita el restablecimiento de contraseña al administrador.'); return }
    if (!email) { setError('Ingresa tu correo electrónico para recuperar tu contraseña.'); return }
    try { await onResetPassword(email); setError('Si el correo está registrado, recibirás instrucciones para restablecer tu contraseña.') }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudo enviar el correo de recuperación.') }
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
            <div className="login-form-meta"><label className="remember-check"><input type="checkbox" defaultChecked /><span>Recordarme</span></label><button className="text-button" type="button" onClick={handleResetPassword}>¿Olvidaste tu contraseña?</button></div>
            {(error || authError) && <div className="form-error"><InfoIcon size={16} /> {error || authError}</div>}
            <button className="primary-button primary-button--large" type="submit" disabled={busy}>{busy ? 'Validando…' : <>Ingresar <ArrowIcon size={18} /></>}</button>
          </form>
          <div className="login-help"><span>¿Necesitas ayuda?</span> <button className="text-button" type="button">Contactar a soporte</button></div>
          {demoMode && <div className="demo-hint"><span className="demo-hint__dot" /><p><strong>Modo demo disponible</strong><small>Usa cualquier correo y contraseña para explorar.</small></p></div>}
        </div>
      </section>
    </main>
  )
}
