/**
 * Browser notifications — foreground only for v1.
 *
 * The Tasks tab polls the workflow runs every 10s. When a run flips from
 * in-progress to completed and the user has granted notification permission,
 * we fire a desktop / iOS lock-screen notification (PWA installed) with a
 * link straight to the run.
 *
 * No push-server flow yet. PR M will wire the workflow to call back into our
 * /api/notify endpoint so notifications fire even when the dashboard isn't
 * open. v1 still gives 80% of the value: most users keep one tab open.
 */

export type PermissionState = 'granted' | 'denied' | 'default' | 'unsupported'

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window
}

export function permission(): PermissionState {
  if (!notificationsSupported()) return 'unsupported'
  return (window.Notification as unknown as { permission: PermissionState }).permission
}

export async function requestPermission(): Promise<PermissionState> {
  if (!notificationsSupported()) return 'unsupported'
  try {
    const result = await window.Notification.requestPermission()
    return result as PermissionState
  } catch {
    return 'denied'
  }
}

interface NotifyOpts {
  title:  string
  body?:  string
  /** URL to open when the notification is clicked. */
  url?:   string
  /** Coalesces notifications under the same id (later ones replace earlier). */
  tag?:   string
  /** When true, the notification stays on screen until dismissed. */
  sticky?: boolean
}

export async function notify(opts: NotifyOpts): Promise<void> {
  if (permission() !== 'granted') return

  // Prefer the service worker so iOS PWA + desktop both render the same way
  // and clicks route through the SW's notificationclick handler (which can
  // focus / navigate the SPA).
  try {
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      const reg = await navigator.serviceWorker.ready
      await reg.showNotification(opts.title, {
        body:    opts.body ?? '',
        icon:    '/icon.svg',
        badge:   '/icon.svg',
        tag:     opts.tag,
        data:    { url: opts.url ?? '/#dashboard' },
        requireInteraction: !!opts.sticky,
      })
      return
    }
  } catch { /* fall through to direct */ }

  try {
    const n = new Notification(opts.title, {
      body: opts.body ?? '',
      icon: '/icon.svg',
      tag:  opts.tag,
    })
    if (opts.url) {
      n.onclick = () => {
        try { window.focus() } catch {}
        window.open(opts.url, '_blank')?.focus()
        n.close()
      }
    }
  } catch { /* surface nothing — best-effort */ }
}
