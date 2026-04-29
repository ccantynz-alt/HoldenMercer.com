/**
 * useSovereignAPI — talks to the FastAPI backend.
 * Vite proxy forwards /api/* and /health to localhost:8000 in dev.
 */

import { useState, useCallback } from 'react'
import { v4 as uuidv4 } from 'uuid'

const API_KEY = import.meta.env.VITE_SOVEREIGN_API_KEY || ''

function authHeaders() {
  const h = { 'Content-Type': 'application/json' }
  if (API_KEY) h['X-Sovereign-Key'] = API_KEY
  return h
}

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: authHeaders(),
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

  // ── Text command ─────────────────────────────────────────────────────────
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

  // ── Audio blob → Whisper → Haiku ─────────────────────────────────────────
  const refineAudio = useCallback(async (audioBlob, sessionId) => {
    setLoading(true)
    setError(null)
    try {
      const ext = audioBlob.type.includes('ogg') ? '.ogg'
                : audioBlob.type.includes('mp4') ? '.mp4'
                : '.webm'
      const form = new FormData()
      form.append('audio', audioBlob, `recording${ext}`)
      form.append('session_id', sessionId || uuidv4())

      const headers = {}
      if (API_KEY) headers['X-Sovereign-Key'] = API_KEY

      const res = await fetch('/api/refine-dictation', {
        method: 'POST',
        headers,
        body: form,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw new Error(err.detail || `HTTP ${res.status}`)
      }
      return res.json()
    } catch (err) {
      setError(err.message)
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  // ── Health probe ─────────────────────────────────────────────────────────
  const checkHealth = useCallback(async () => {
    try {
      const res = await fetch('/health')
      return res.ok ? res.json() : null
    } catch {
      return null
    }
  }, [])

  return { sendCommand, refineAudio, checkHealth, loading, error }
}
