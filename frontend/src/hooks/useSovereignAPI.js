/**
 * useSovereignAPI — talks to the FastAPI backend.
 * Vite proxy forwards /api/* and /health to localhost:8000 in dev.
 */

import { useState, useCallback } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { authFetch } from '../stores/auth'

async function post(path, body) {
  const res = await authFetch(path, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || `HTTP ${res.status}`)
  }
  return res.json()
}

export function useSovereignAPI() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const sendCommand = useCallback(async ({ text, mode }) => {
    setLoading(true)
    setError(null)
    try {
      return await post('/api/command', { text, mode, session_id: uuidv4() })
    } catch (err) {
      setError(err.message)
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  const checkHealth = useCallback(async () => {
    try {
      const res = await fetch('/health')
      return res.ok ? res.json() : null
    } catch {
      return null
    }
  }, [])

  return { sendCommand, checkHealth, loading, error }
}
