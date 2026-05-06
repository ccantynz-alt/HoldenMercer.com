/**
 * Toast store — inline status messages instead of native browser alerts.
 *
 * Browser alert() blocks the UI, dropdowns from the top of the screen,
 * and feels like 1998. We replace every alert() call with a toast pushed
 * onto this store, rendered as a stack in the corner of the dashboard.
 *
 * Toasts auto-dismiss after a kind-specific TTL; clicking dismisses
 * immediately. Stack is rendered by <ToastStack /> mounted at App level.
 */

import { create } from 'zustand'

export type ToastKind = 'info' | 'success' | 'error'

export interface Toast {
  id:    string
  kind:  ToastKind
  title: string
  body?: string
  ttlMs: number
  at:    number
}

interface ToastState {
  toasts: Toast[]
  push:   (input: { kind: ToastKind; title: string; body?: string; ttlMs?: number }) => string
  dismiss:(id: string) => void
  clear:  () => void
}

const DEFAULT_TTL: Record<ToastKind, number> = {
  info:    5000,
  success: 5000,
  error:   8000,
}

export const useToast = create<ToastState>((set, get) => ({
  toasts: [],
  push: ({ kind, title, body, ttlMs }) => {
    const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const ttl = ttlMs ?? DEFAULT_TTL[kind]
    const toast: Toast = { id, kind, title, body, ttlMs: ttl, at: Date.now() }
    set((s) => ({ toasts: [...s.toasts, toast] }))
    if (ttl > 0) {
      setTimeout(() => get().dismiss(id), ttl)
    }
    return id
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clear:   () => set({ toasts: [] }),
}))

/** Convenience helper — call this anywhere instead of alert(). */
export function toast(kind: ToastKind, title: string, body?: string): string {
  return useToast.getState().push({ kind, title, body })
}
