/**
 * Auth store — single-user email/password session.
 *
 * Token is signed by the backend (HMAC-SHA256, see core/session_token.py)
 * and persisted to localStorage so refreshes survive. On app boot we hit
 * /api/auth/me to confirm the token still validates server-side; if not,
 * we clear and the SPA falls back to the login screen.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface AuthState {
  token:        string | null
  email:        string | null
  expiresAt:    number | null     // unix seconds
  status:       'idle' | 'loading' | 'authed' | 'unauthed'
  errorMessage: string | null
  login:        (email: string, password: string) => Promise<boolean>
  logout:       () => void
  /** Verify the persisted token against the backend on app boot. */
  bootstrap:    () => Promise<void>
}

export const useAuth = create<AuthState>()(
  persist(
    (set, get) => ({
      token:        null,
      email:        null,
      expiresAt:    null,
      status:       'idle',
      errorMessage: null,

      login: async (email, password) => {
        set({ status: 'loading', errorMessage: null })
        try {
          const res = await fetch('/api/auth/login', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ email, password }),
          })
          if (!res.ok) {
            const body = await res.json().catch(() => ({ detail: res.statusText }))
            set({ status: 'unauthed', errorMessage: body.detail || `HTTP ${res.status}` })
            return false
          }
          const data = await res.json()
          set({
            token:        data.token,
            email:        data.email,
            expiresAt:    data.expires_at,
            status:       'authed',
            errorMessage: null,
          })
          return true
        } catch (err) {
          set({ status: 'unauthed', errorMessage: (err as Error).message })
          return false
        }
      },

      logout: () => set({
        token: null, email: null, expiresAt: null,
        status: 'unauthed', errorMessage: null,
      }),

      bootstrap: async () => {
        const { token, expiresAt } = get()
        if (!token) {
          set({ status: 'unauthed' })
          return
        }
        // Cheap client-side expiry check — saves a request when the token is obviously dead
        if (expiresAt && expiresAt * 1000 < Date.now()) {
          set({ token: null, email: null, expiresAt: null, status: 'unauthed' })
          return
        }
        set({ status: 'loading' })
        try {
          const res = await fetch('/api/auth/me', {
            headers: { Authorization: `Bearer ${token}` },
          })
          if (!res.ok) {
            set({ token: null, email: null, expiresAt: null, status: 'unauthed' })
            return
          }
          const data = await res.json()
          set({ status: 'authed', email: data.email })
        } catch {
          set({ status: 'unauthed' })
        }
      },
    }),
    {
      name: 'holdenmercer:auth:v1',
      partialize: (s) => ({ token: s.token, email: s.email, expiresAt: s.expiresAt }),
    }
  )
)

/** Tiny fetch wrapper — adds Authorization, surfaces 401s as logout. */
export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = useAuth.getState().token
  const headers = new Headers(init.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')

  const res = await fetch(input, { ...init, headers })
  if (res.status === 401) {
    useAuth.getState().logout()
  }
  return res
}
