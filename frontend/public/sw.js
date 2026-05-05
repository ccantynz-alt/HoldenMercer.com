/**
 * Holden Mercer — service worker.
 *
 * Minimal v1: lifecycle stubs so the app installs as a PWA and gets the
 * "Add to Home Screen" prompt. No caching yet (the dashboard is dynamic
 * and we don't want stale UI). Push notifications run in the foreground
 * via the Notifications API directly from the SPA — no push-server flow
 * yet (that's PR M).
 */

self.addEventListener('install', (event) => {
  // Activate immediately on install — no precache step yet.
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

// Future hook for web push (server-side push) — when notifications are
// dispatched via Push API, this is where we render them. Foreground
// notifications today don't need this.
self.addEventListener('push', (event) => {
  let payload = { title: 'Holden Mercer', body: 'Update' }
  try { payload = event.data ? event.data.json() : payload } catch {}
  event.waitUntil(
    self.registration.showNotification(payload.title || 'Holden Mercer', {
      body:   payload.body || '',
      icon:   '/icon.svg',
      badge:  '/icon.svg',
      data:   payload.data || {},
      tag:    payload.tag  || 'hm',
    })
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/#dashboard'
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of all) {
      if ('focus' in client) {
        client.focus()
        if ('navigate' in client) client.navigate(url)
        return
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(url)
  })())
})
