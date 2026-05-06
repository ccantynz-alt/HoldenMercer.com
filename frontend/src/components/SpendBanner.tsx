/**
 * SpendBanner — fixed top strip showing today's API spend at all times.
 *
 * Stays visible from EVERY screen so the user never has to dig for the
 * usage card to know what's burning. Tints + warns when:
 *   • Pause toggle is ON (red)
 *   • Today's spend ≥ 80% of cap (amber)
 *   • Today's spend over cap (red)
 *
 * Click anywhere on the banner to open Settings → API spend controls.
 */

import { useUsage, summarise } from '../stores/usage'
import { useSettings } from '../stores/settings'

interface Props {
  onOpenSettings?: () => void
}

export function SpendBanner({ onOpenSettings }: Props = {}) {
  const days   = useUsage((s) => s.days)
  const pause  = useSettings((s) => s.pauseAutoDispatch)
  const cap    = useSettings((s) => s.dailyCostCapUsd)

  const today = summarise(days, 1).totalDollars

  // Hide when there's nothing notable: no spend AND no cap AND not paused.
  if (today === 0 && cap === 0 && !pause) return null

  const overCap   = cap > 0 && today >= cap
  const nearCap   = cap > 0 && !overCap && today >= cap * 0.8

  const bg =
    pause   ? 'rgba(239,68,68,0.18)'
    : overCap ? 'rgba(239,68,68,0.18)'
    : nearCap ? 'rgba(234,179,8,0.15)'
    : 'rgba(99,102,241,0.10)'
  const accent =
    pause || overCap ? 'var(--error, #ef4444)'
    : nearCap        ? 'var(--warn, #eab308)'
    : 'var(--text-muted)'

  const text = pause
    ? '🛑 ALL DISPATCHES PAUSED — open Settings to resume'
    : overCap
    ? `🛑 Daily cap hit · today $${today.toFixed(2)} of $${cap.toFixed(2)} · dispatches refused`
    : nearCap
    ? `⚠ Today $${today.toFixed(2)} of $${cap.toFixed(2)} cap (${Math.round(today / cap * 100)}%)`
    : `Today's API spend: $${today.toFixed(today < 1 ? 3 : 2)}${cap > 0 ? ` of $${cap.toFixed(2)} cap` : ''}`

  return (
    <button
      onClick={onOpenSettings}
      style={{
        width: '100%', padding: '6px 16px',
        background: bg, color: accent,
        border: 'none', borderBottom: `1px solid ${accent}`,
        cursor: onOpenSettings ? 'pointer' : 'default',
        fontSize: 12, fontWeight: 500, textAlign: 'left',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}
      title={pause || overCap || nearCap ? 'Click to open Settings → API spend controls' : "Today's API spend"}
    >
      <span>{text}</span>
      <span style={{ opacity: 0.7, fontSize: 11 }}>
        {pause || overCap || nearCap ? 'click to manage →' : ''}
      </span>
    </button>
  )
}
