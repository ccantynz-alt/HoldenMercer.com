/**
 * ApiMonitor — always-visible live API activity feed.
 *
 * User: "I don't even know it was making API calls it shouldn't be making
 * any API calls."
 *
 * Sits under the SpendBanner on every screen. Polls /api/jobs/list every
 * 15s for recent task runs (the only path that drives Anthropic spend).
 *
 * Default state: collapsed strip showing live counts:
 *   "🟢 0 running · 4 today · $0.42"
 *
 * Click to expand: shows the last 10 task runs with trigger source
 * (workflow_dispatch / schedule / repository_dispatch / webhook), status,
 * conclusion, branch, and when. So if something is firing tasks the user
 * didn't ask for, they see it within 15 seconds.
 *
 * Trigger annotations:
 *   • dispatch       — user clicked a button in HM
 *   • webhook        — gatetest.ai webhook → backend auto-fix path
 *   • schedule       — cron evaluator (every 15min)
 *   • push           — branch push triggered the gate
 *   • unknown        — we can't tell from the run metadata
 */

import { useEffect, useMemo, useState } from 'react'
import { useUsage, summarise } from '../stores/usage'
import { listTaskRuns, type TaskRun } from '../lib/jobs'
import { useProjects } from '../stores/projects'

interface Props {
  /** When set, the monitor renders even with no data (so the user can see
   *  it exists). Default false (hides until there's something to show). */
  alwaysShow?: boolean
}

interface Annotated extends TaskRun {
  trigger: 'dispatch' | 'webhook' | 'schedule' | 'push' | 'unknown'
}

export function ApiMonitor({ alwaysShow = false }: Props) {
  const projects = useProjects((s) => s.projects)
  const linked   = useMemo(() => projects.filter((p) => !!p.repo), [projects])
  const days     = useUsage((s) => s.days)
  const todaySpend = summarise(days, 1).totalDollars

  const [runs, setRuns]       = useState<Annotated[]>([])
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [error, setError]     = useState<string | null>(null)

  // Poll every 15s. Reads from the centralized HM dispatch repo via the
  // existing /api/jobs/list endpoint (any project repo arg works since
  // the backend ignores it for centralized model — uses HM_DISPATCH_REPO).
  useEffect(() => {
    let cancelled = false
    const fetchOnce = async () => {
      const repo = linked[0]?.repo
      if (!repo) return
      setLoading(true)
      try {
        const data = await listTaskRuns(repo, undefined)
        if (cancelled) return
        const annotated: Annotated[] = (data.runs || []).slice(0, 10).map((r) => ({
          ...r,
          trigger: classifyTrigger(r),
        }))
        setRuns(annotated)
        setError(null)
      } catch (err) {
        if (!cancelled) setError((err as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetchOnce()
    const id = setInterval(fetchOnce, 15_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [linked])

  const running = runs.filter((r) => r.status !== 'completed').length
  const todayCount = runs.filter((r) => {
    const t = Date.parse(r.created_at ?? '')
    if (!t) return false
    const d = new Date(t)
    const now = new Date()
    return d.toDateString() === now.toDateString()
  }).length

  // Hide entirely when there's no signal AND user hasn't requested always-show
  if (!alwaysShow && runs.length === 0 && todaySpend === 0) return null

  const stripBg = running > 0
    ? 'rgba(234,179,8,0.10)'
    : 'rgba(99,102,241,0.05)'
  const stripBorder = running > 0
    ? 'rgba(234,179,8,0.3)'
    : 'rgba(99,102,241,0.2)'

  return (
    <div style={{
      borderBottom: `1px solid ${stripBorder}`,
      background: stripBg,
      fontSize: 12,
    }}>
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          width: '100%', padding: '6px 16px',
          background: 'transparent', border: 'none', textAlign: 'left',
          color: 'var(--text)', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        }}
        title="Click to toggle live API activity feed"
      >
        <span>
          <strong style={{ color: running > 0 ? 'var(--warn, #eab308)' : 'var(--ok, #22c55e)' }}>
            {running > 0 ? '◌' : '🟢'} {running} running
          </strong>
        </span>
        <span style={{ color: 'var(--text-muted)' }}>
          · {todayCount} task{todayCount === 1 ? '' : 's'} today
        </span>
        <span style={{ color: 'var(--text-muted)' }}>
          · ${todaySpend.toFixed(todaySpend < 1 ? 3 : 2)} spent
        </span>
        {error && (
          <span style={{ color: 'var(--error)' }}>· error: {error.slice(0, 80)}</span>
        )}
        <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 11 }}>
          {loading ? 'refreshing…' : 'auto-refreshes every 15s'}
          {' · '}
          <span>{expanded ? 'click to collapse' : 'click to expand'}</span>
        </span>
      </button>

      {expanded && (
        <div style={{ padding: '0 16px 10px', maxHeight: '40vh', overflowY: 'auto' }}>
          {runs.length === 0 ? (
            <p style={{ margin: 0, padding: '6px 0', color: 'var(--text-muted)' }}>
              No recent task runs.
            </p>
          ) : (
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                  <th style={th}>Status</th>
                  <th style={th}>Trigger</th>
                  <th style={th}>Branch</th>
                  <th style={th}>Started</th>
                  <th style={th}>Run</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const ok   = r.status === 'completed' && r.conclusion === 'success'
                  const fail = r.status === 'completed' && r.conclusion && r.conclusion !== 'success' && r.conclusion !== 'skipped'
                  const icon = ok ? '✅' : fail ? '❌' : r.status === 'in_progress' ? '◌' : '·'
                  return (
                    <tr key={r.id} style={{ borderTop: '1px solid var(--border, #2a2a2a)' }}>
                      <td style={td}>
                        <span title={`${r.status} · ${r.conclusion ?? ''}`}>{icon}</span>{' '}
                        <span style={{ color: 'var(--text-muted)' }}>
                          {r.status === 'completed' ? (r.conclusion ?? 'done') : r.status}
                        </span>
                      </td>
                      <td style={td}>
                        <TriggerPill trigger={r.trigger} />
                      </td>
                      <td style={td}><code style={{ fontSize: 11 }}>{r.branch || '—'}</code></td>
                      <td style={td}>{formatRelative(r.created_at)}</td>
                      <td style={td}>
                        <a href={r.html_url} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>
                          open ↗
                        </a>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}

function classifyTrigger(r: TaskRun): Annotated['trigger'] {
  // GitHub Actions runs include an `event` field in the API. Our list
  // endpoint passes it through (when available) under `event`.
  const e = (r as unknown as { event?: string }).event
  if (e === 'workflow_dispatch')    return 'dispatch'
  if (e === 'schedule')             return 'schedule'
  if (e === 'repository_dispatch')  return 'webhook'
  if (e === 'push')                 return 'push'
  // Fallback: branch-name heuristic
  if (r.branch && r.branch.startsWith('claude/')) return 'dispatch'
  return 'unknown'
}

function TriggerPill({ trigger }: { trigger: Annotated['trigger'] }) {
  const styles: Record<Annotated['trigger'], { bg: string; color: string; label: string }> = {
    dispatch: { bg: 'rgba(99,102,241,0.15)',  color: 'var(--text)',          label: '🖱 dispatch' },
    webhook:  { bg: 'rgba(234,179,8,0.18)',    color: 'var(--warn, #eab308)', label: '🪝 webhook'  },
    schedule: { bg: 'rgba(99,102,241,0.10)',  color: 'var(--text-muted)',    label: '⏰ schedule' },
    push:     { bg: 'rgba(34,197,94,0.10)',   color: 'var(--ok, #22c55e)',   label: '↪ push'     },
    unknown:  { bg: 'rgba(255,255,255,0.05)', color: 'var(--text-muted)',    label: '? unknown'  },
  }
  const s = styles[trigger]
  return (
    <span
      style={{
        padding: '1px 6px', borderRadius: 4, fontSize: 11,
        background: s.bg, color: s.color,
      }}
    >
      {s.label}
    </span>
  )
}

const th: React.CSSProperties = { padding: '6px 8px', fontWeight: 500, fontSize: 11 }
const td: React.CSSProperties = { padding: '6px 8px' }

function formatRelative(iso: string | undefined): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (!t) return '—'
  const diff = Date.now() - t
  const m = Math.floor(diff / 60_000)
  if (m < 1)  return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}
