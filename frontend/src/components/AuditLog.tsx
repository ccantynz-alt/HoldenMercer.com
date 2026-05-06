/**
 * AuditLog — global chronological feed across every linked project.
 *
 * "What happened today / while I was away" in one place. Aggregates:
 *   • Commits across all linked projects
 *   • Open PRs across all linked projects
 *   • In-progress / recent task runs (centralized HM dispatch repo)
 *   • Crashes captured by ErrorBoundary in this browser session
 *
 * This is the admin observability surface — what a real ops console
 * looks like, not the "click into each project to see what's going on"
 * scavenger hunt. Click any row to open the source.
 */

import { useEffect, useMemo, useState } from 'react'
import { useProjects, type Project } from '../stores/projects'
import { useSettings } from '../stores/settings'
import {
  recentCommits, openPullRequests, inProgressRuns,
} from '../lib/repo'
import { listTaskRuns } from '../lib/jobs'

type EventKind = 'commit' | 'pr' | 'run' | 'task' | 'crash'
type FilterKind = EventKind | 'all'

interface AuditEvent {
  id:       string
  kind:     EventKind
  ts:       number
  project?: Project
  title:    string
  meta:     string
  url?:     string
  status?:  'ok' | 'fail' | 'pending'
}

interface CrashRecord {
  message:        string
  stack?:         string
  componentStack?: string
  at:             string
}

const FILTERS: { id: FilterKind; label: string }[] = [
  { id: 'all',    label: 'All' },
  { id: 'task',   label: 'Tasks' },
  { id: 'pr',     label: 'PRs' },
  { id: 'commit', label: 'Commits' },
  { id: 'run',    label: 'Gate runs' },
  { id: 'crash',  label: 'Crashes' },
]

export function AuditLog() {
  const projects   = useProjects((s) => s.projects)
  const githubKey  = useSettings((s) => s.githubToken)
  const linked     = useMemo(() => projects.filter((p) => !!p.repo), [projects])

  const [events,  setEvents]  = useState<AuditEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [filter,  setFilter]  = useState<FilterKind>('all')
  const [tick,    setTick]    = useState(0)

  useEffect(() => {
    if (!githubKey) {
      setError('Add a code-host PAT in Settings to see activity.')
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const out: AuditEvent[] = []

        // Per-project commits / PRs / gate runs
        const projResults = await Promise.all(linked.map(async (p) => {
          const repo   = p.repo!
          const branch = p.branch || null
          const [commits, prs, runs] = await Promise.all([
            recentCommits(repo, branch, 8).catch(() => []),
            openPullRequests(repo, 8).catch(() => []),
            inProgressRuns(repo, 8).catch(() => []),
          ])
          return { p, commits, prs, runs }
        }))

        for (const { p, commits, prs, runs } of projResults) {
          for (const c of commits) {
            out.push({
              id:      `commit-${p.id}-${c.sha}`,
              kind:    'commit',
              ts:      Date.parse(c.date) || 0,
              project: p,
              title:   c.message.split('\n')[0],
              meta:    `${c.sha} · ${c.author ?? '?'}`,
              url:     c.url,
            })
          }
          for (const pr of prs) {
            out.push({
              id:      `pr-${p.id}-${pr.number}`,
              kind:    'pr',
              ts:      Date.parse(pr.updated_at) || 0,
              project: p,
              title:   pr.title,
              meta:    `#${pr.number} · ${pr.head} → ${pr.base} · ${pr.author ?? '?'}`,
              url:     pr.url,
            })
          }
          for (const r of runs) {
            out.push({
              id:      `run-${p.id}-${r.id}`,
              kind:    'run',
              ts:      Date.parse(r.started) || 0,
              project: p,
              title:   r.workflow,
              meta:    `${r.branch} · ${r.status}`,
              url:     r.url,
              status:  r.status === 'completed' ? 'ok' : 'pending',
            })
          }
        }

        // Centralized task runs — pulls from HM dispatch repo regardless of project
        if (linked.length > 0) {
          try {
            const taskData = await listTaskRuns(linked[0].repo!, undefined)
            for (const tr of taskData.runs) {
              const ok   = tr.status === 'completed' && tr.conclusion === 'success'
              const fail = tr.status === 'completed' && tr.conclusion && tr.conclusion !== 'success'
              out.push({
                id:     `task-${tr.id}`,
                kind:   'task',
                ts:     Date.parse(tr.created_at ?? '') || 0,
                title:  tr.name || `Task ${tr.id}`,
                meta:   `${tr.branch ?? '?'} · ${tr.status}${tr.conclusion ? ` · ${tr.conclusion}` : ''}`,
                url:    tr.html_url,
                status: ok ? 'ok' : fail ? 'fail' : 'pending',
              })
            }
          } catch { /* swallow — non-critical */ }
        }

        // Last crash captured in this browser session (set by ErrorBoundary)
        const lastCrash = (window as unknown as Record<string, CrashRecord | undefined>).__hmLastCrash
        if (lastCrash) {
          out.push({
            id:     `crash-${lastCrash.at}`,
            kind:   'crash',
            ts:     Date.parse(lastCrash.at) || 0,
            title:  lastCrash.message?.slice(0, 120) || 'Unknown crash',
            meta:   `Captured ${new Date(lastCrash.at).toLocaleString()} · DevTools: window.__hmLastCrash`,
            status: 'fail',
          })
        }

        out.sort((a, b) => b.ts - a.ts)
        if (!cancelled) setEvents(out.slice(0, 100))
      } catch (err) {
        if (!cancelled) setError((err as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [linked, githubKey, tick])

  const filtered = filter === 'all' ? events : events.filter((e) => e.kind === filter)

  return (
    <div className="hm-home">
      <header className="hm-home-header">
        <div>
          <h1 className="hm-home-title">Audit log</h1>
          <p className="hm-home-tagline">
            Everything Holden Mercer + your projects did, newest first.
            What happened while you were away.
          </p>
        </div>
        <div className="hm-home-actions">
          <button
            className="hm-btn-ghost"
            onClick={() => setTick((n) => n + 1)}
            disabled={loading}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      {error && <div className="hm-memory-error">{error}</div>}

      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {FILTERS.map((f) => {
          const count = f.id === 'all' ? events.length : events.filter((e) => e.kind === f.id).length
          return (
            <button
              key={f.id}
              className={`hm-btn-ghost${filter === f.id ? ' is-active' : ''}`}
              style={filter === f.id ? { background: 'var(--bg-elev)', fontWeight: 600 } : undefined}
              onClick={() => setFilter(f.id)}
            >
              {f.label} {count > 0 && <span style={{ color: 'var(--text-muted)' }}>· {count}</span>}
            </button>
          )
        })}
      </div>

      {filtered.length === 0 && !loading && (
        <p className="hm-home-empty">
          No {filter === 'all' ? 'activity' : filter} events.
        </p>
      )}

      <ul className="hm-home-feed">
        {filtered.map((ev) => {
          const icon =
            ev.kind === 'commit' ? '◆'
            : ev.kind === 'pr'   ? '⤴'
            : ev.kind === 'run'  ? '◌'
            : ev.kind === 'task' ? (ev.status === 'ok' ? '✅' : ev.status === 'fail' ? '❌' : '◌')
            : ev.kind === 'crash' ? '🚨'
            : '·'
          return (
            <li key={ev.id}>
              <div className="hm-home-event" style={{ cursor: ev.url ? 'pointer' : 'default' }}>
                <span className={`hm-home-kind hm-home-kind-${ev.kind}`}>{icon}</span>
                <span className="hm-home-event-body">
                  <span className="hm-home-event-title">{ev.title}</span>
                  <span className="hm-home-event-meta">
                    {ev.project ? `${ev.project.name} · ` : ''}{ev.meta} · {formatRelative(ev.ts)}
                  </span>
                </span>
                {ev.url && (
                  <a
                    href={ev.url}
                    target="_blank"
                    rel="noreferrer"
                    className="hm-home-event-link"
                  >open ↗</a>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function formatRelative(ts: number): string {
  if (!ts) return '—'
  const diff = Date.now() - ts
  if (diff < 0) return 'just now'
  const m = Math.floor(diff / 60_000)
  if (m < 1)  return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(ts).toLocaleDateString()
}
