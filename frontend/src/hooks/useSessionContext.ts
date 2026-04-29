/**
 * useSessionContext — lightweight local state buffer.
 *
 * Tracks what Holden is currently looking at so voice commands can be
 * contextualised without repeating yourself.  Persisted to sessionStorage
 * so it survives hot-reloads but clears on tab close.
 *
 * Usage:
 *   const { context, setFile, setRepo, pushCommand, getRouteContext } = useSessionContext()
 *
 *   // Tell the context where you are
 *   setFile('src/components/LiquidOrb.tsx')
 *   setRepo('sovereign-ai')
 *
 *   // Pass to /api/route so Claude knows what "Fix this" refers to
 *   const packet = await fetch('/api/route', {
 *     body: JSON.stringify({ transcript, session_id, context: getRouteContext() })
 *   })
 */

import { useState, useCallback, useRef } from 'react'

export interface SessionContext {
  currentFile:   string | null
  currentRepo:   string | null
  currentBranch: string | null
  recentActions: string[]         // last 10 Action Packet types
  conversationTurns: number       // how many exchanges this session
  lastIntent:    string | null
}

const STORAGE_KEY = 'sovereign_session_ctx'
const MAX_ACTIONS = 10

function load(): SessionContext {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return {
    currentFile:       null,
    currentRepo:       null,
    currentBranch:     null,
    recentActions:     [],
    conversationTurns: 0,
    lastIntent:        null,
  }
}

function save(ctx: SessionContext): void {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(ctx)) } catch { /* ignore */ }
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useSessionContext() {
  const [context, setContext] = useState<SessionContext>(load)
  const contextRef = useRef(context)
  contextRef.current = context

  const update = useCallback((patch: Partial<SessionContext>) => {
    setContext(prev => {
      const next = { ...prev, ...patch }
      save(next)
      return next
    })
  }, [])

  const setFile = useCallback((path: string | null) => {
    update({ currentFile: path })
  }, [update])

  const setRepo = useCallback((repo: string | null, branch?: string) => {
    update({ currentRepo: repo, currentBranch: branch ?? null })
  }, [update])

  const pushAction = useCallback((action: string, intent?: string) => {
    update(prev => ({
      ...prev,
      recentActions: [action, ...prev.recentActions].slice(0, MAX_ACTIONS),
      conversationTurns: prev.conversationTurns + 1,
      lastIntent: intent ?? prev.lastIntent,
    }) as Partial<SessionContext>)
  }, [update])

  /** Returns the context object to send in /api/route requests. */
  const getRouteContext = useCallback(() => {
    const ctx = contextRef.current
    return {
      current_file:   ctx.currentFile,
      current_repo:   ctx.currentRepo,
      current_branch: ctx.currentBranch,
      last_intent:    ctx.lastIntent,
      recent_actions: ctx.recentActions.slice(0, 3).join(', ') || null,
    }
  }, [])

  return {
    context,
    setFile,
    setRepo,
    pushAction,
    getRouteContext,
    reset: useCallback(() => {
      const empty: SessionContext = {
        currentFile: null, currentRepo: null, currentBranch: null,
        recentActions: [], conversationTurns: 0, lastIntent: null,
      }
      save(empty)
      setContext(empty)
    }, []),
  }
}
