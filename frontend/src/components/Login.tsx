/**
 * Login — single-user gate.
 *
 * Posts {email, password} to /api/auth/login. On success the auth store
 * holds a Bearer token that subsequent API calls send automatically.
 */

import { useState } from 'react'
import { useAuth } from '../stores/auth'

interface Props {
  onSuccess?: () => void
}

export function Login({ onSuccess }: Props) {
  const login = useAuth((s) => s.login)
  const status = useAuth((s) => s.status)
  const errorMessage = useAuth((s) => s.errorMessage)
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const ok = await login(email, password)
    if (ok) onSuccess?.()
  }

  return (
    <div className="hm-login-shell">
      <form className="hm-login-card" onSubmit={submit}>
        <h1 className="hm-login-title">Holden&nbsp;Mercer</h1>
        <p className="hm-login-lede">Sign in to your console.</p>

        <label className="hm-field">
          <span className="hm-field-label">Email</span>
          <input
            className="hm-input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            autoFocus
            required
          />
        </label>

        <label className="hm-field">
          <span className="hm-field-label">Password</span>
          <input
            className="hm-input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        {errorMessage && (
          <div className="hm-login-error">{errorMessage}</div>
        )}

        <button
          type="submit"
          className="hm-btn-primary hm-login-submit"
          disabled={status === 'loading' || !email || !password}
        >
          {status === 'loading' ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="hm-login-foot">
          Single-user dashboard. If this is your first time, the credentials are the
          ones in your Vercel <code>ADMIN_EMAIL</code> / <code>ADMIN_PASSWORD</code> env vars.
        </p>
      </form>
    </div>
  )
}
