/**
 * AdminHome — what you see when no project is selected.
 *
 * Replaces the old empty "Pick a project from the sidebar" placeholder
 * with a real activity dashboard. Aggregates across every linked project:
 *   • Stats: project count, open PRs, in-flight runs, today's commits
 *   • Recent activity feed: commits / PRs / runs across ALL projects,
 *     newest first, click-through to GitHub
 *   • Quick actions: + New project · open the most-recent-edited project
 *
 * Reads from the same lib/repo helpers the Console pre-flight uses, so
 * there's no new backend call surface — just parallel fetches per linked
 * project.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useProjects, type Project } from '../stores/projects'
import { useSettings } from '../stores/settings'
import { useUsage, summarise } from '../stores/usage'
import {
  recentCommits, openPullRequests, inProgressRuns,
  type RecentCommit, type OpenPR, type InProgressRun,
} from '../lib/repo'

interface Props {
  onNewProject:  () => void
  onOpenProject: (id: string) => void
  onOpenSettings: () => void
}

interface ActivityEvent {
  kind:      'commit' | 'pr' | 'run'
  ts:        number
  project:   Project
  title:     string
  meta:      string
  url:       string
}

export function AdminHome({ onNewProject, onOpenProject, onOpenSettings }: Props) {
  const projects   = useProjects((s) => s.projects)
  const linked     = useMemo(() => projects.filter((p) => !!p.repo), [projects])
  const githubKey  = useSettings((s) => s.githubToken)

  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState<string | null>(null)
  const [byProject, setByProject] = useState<Record<string, {
    commits: RecentCommit[]
    prs:     OpenPR[]
    runs:    InProgressRun[]
  }>>({})
  const [refreshTick, setRefreshTick] = useState(0)
  const refresh = () => setRefreshTick((n) => n + 1)

  // Defensive: if this effect somehow re-fires more than 10 times in 2 seconds
  // (which would indicate an infinite loop and would crash the dashboard with
  // React-185), bail out and surface a diagnostic instead. Belt-and-suspenders
  // for the prod crash we've been chasing.
  const fireCountRef = useRef<{ count: number; windowStart: number }>({ count: 0, windowStart: 0 })

  // Fetch on mount + when projects/key change + when manual refresh fires.
  // Depend on `projects` (zustand-stable) NOT `linked` (useMemo, may rebuild).
  // useMemo + useEffect was the React-185 max-update-depth source.
  useEffect(() => {
    const now = Date.now()
    const tracker = fireCountRef.current
    if (now - tracker.windowStart > 2000) {
      tracker.windowStart = now
      tracker.count = 0
    }
    tracker.count += 1
    if (tracker.count > 10) {
      // eslint-disable-next-line no-console
      console.error('AdminHome effect re-firing in a loop — aborting to protect the dashboard')
      setError('Activity refresh aborted (loop guard tripped). Check console.')
      return
    }

    const targets = projects.filter((p) => !!p.repo)
    if (targets.length === 0) return
    if (!githubKey) {
      setError('Add a code-host PAT in Settings to see activity.')
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const results = await Promise.all(targets.map(async (p) => {
          const repo   = p.repo!
          const branch = p.branch || null
          const [commits, prs, runs] = await Promise.all([
            recentCommits(repo, branch, 5).catch(() => []),
            openPullRequests(repo, 5).catch(() => []),
            inProgressRuns(repo, 5).catch(() => []),
          ])
          return [p.id, { commits, prs, runs }] as const
        }))
        if (!cancelled) setByProject(Object.fromEntries(results))
      } catch (err) {
        if (!cancelled) setError((err as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [projects, githubKey, refreshTick])

  // Build the unified activity feed
  const activity: ActivityEvent[] = useMemo(() => {
    const out: ActivityEvent[] = []
    for (const p of linked) {
      const data = byProject[p.id]
      if (!data) continue
      for (const c of data.commits) {
        out.push({
          kind: 'commit', ts: parseDate(c.date), project: p,
          title: c.message, meta: `${c.sha} · ${c.author ?? '?'}`,
          url:   c.url,
        })
      }
      for (const pr of data.prs) {
        out.push({
          kind: 'pr', ts: parseDate(pr.updated_at), project: p,
          title: pr.title,
          meta:  `#${pr.number} · ${pr.head} → ${pr.base} · ${pr.author ?? '?'}`,
          url:   pr.url,
        })
      }
      for (const r of data.runs) {
        out.push({
          kind: 'run', ts: parseDate(r.started), project: p,
          title: `${r.workflow}`,
          meta:  `${r.branch} · ${r.status}`,
          url:   r.url,
        })
      }
    }
    return out.sort((a, b) => b.ts - a.ts).slice(0, 30)
  }, [linked, byProject])

  // Stats
  const stats = useMemo(() => {
    const today    = new Date()
    today.setHours(0, 0, 0, 0)
    const todayMs  = today.getTime()
    let openPRs    = 0
    let runsActive = 0
    let commitsToday = 0
    for (const p of linked) {
      const data = byProject[p.id]
      if (!data) continue
      openPRs    += data.prs.length
      runsActive += data.runs.length
      commitsToday += data.commits.filter((c) => parseDate(c.date) >= todayMs).length
    }
    return {
      projects: projects.length,
      linked:   linked.length,
      openPRs,
      runsActive,
      commitsToday,
    }
  }, [projects, linked, byProject])

  return (
    <div className="hm-home">
      <header className="hm-home-header">
        <div>
          <h1 className="hm-home-title">Home</h1>
          <p className="hm-home-tagline">
            Live activity across every linked project. Picking one from the
            sidebar drills into its Console / Gate / Memory.
          </p>
        </div>
        <div className="hm-home-actions">
          <button className="hm-btn-ghost" onClick={refresh} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button className="hm-btn-primary" onClick={onNewProject}>
            + New project
          </button>
        </div>
      </header>

      {error && <div className="hm-memory-error">{error}</div>}

      <UsageCard />

      <section className="hm-home-stats">
        <StatCard label="Projects"        value={stats.projects} />
        <StatCard label="Linked to repo"  value={stats.linked} />
        <StatCard label="Open PRs"        value={stats.openPRs}      tone="gold" />
        <StatCard label="In-flight runs"  value={stats.runsActive}   tone={stats.runsActive > 0 ? 'gold' : undefined} />
        <StatCard label="Commits today"   value={stats.commitsToday} />
      </section>

      {projects.length === 0 ? (
        <div className="hm-tasks-empty">
          <strong>Nothing here yet.</strong> Click <strong>+ New project</strong>{' '}
          (or open the project sidebar with the ☰ button) to start. You can
          start blank or import an existing repo.
        </div>
      ) : linked.length === 0 ? (
        <div className="hm-tasks-empty">
          You have {projects.length} project{projects.length === 1 ? '' : 's'},
          but none are linked to a repo yet. Open one and click{' '}
          <strong>+ Link a repo</strong> to start seeing activity here.
        </div>
      ) : !githubKey ? (
        <div className="hm-tasks-empty">
          A code-host PAT is needed to read activity from your linked repos.{' '}
          <button className="hm-link-btn" onClick={onOpenSettings}>Open Settings</button>.
        </div>
      ) : (
        <>
          <section className="hm-home-section">
            <h2 className="hm-home-section-title">Recent activity</h2>
            {activity.length === 0 && !loading && (
              <p className="hm-home-empty">
                No recent commits, PRs, or runs across your linked projects.
              </p>
            )}
            <ul className="hm-home-feed">
              {activity.map((ev, i) => (
                <li key={`${ev.kind}-${i}-${ev.ts}-${ev.project.id}`}>
                  <button
                    className="hm-home-event"
                    onClick={() => onOpenProject(ev.project.id)}
                  >
                    <span className={`hm-home-kind hm-home-kind-${ev.kind}`}>
                      {ev.kind === 'commit' ? '◆' : ev.kind === 'pr' ? '⤴' : '◌'}
                    </span>
                    <span className="hm-home-event-body">
                      <span className="hm-home-event-title">{ev.title}</span>
                      <span className="hm-home-event-meta">
                        {ev.project.name} · {ev.meta} · {formatRelative(ev.ts)}
                      </span>
                    </span>
                    {ev.url && (
                      <a
                        href={ev.url}
                        target="_blank"
                        rel="noreferrer"
                        className="hm-home-event-link"
                        onClick={(e) => e.stopPropagation()}
                      >open ↗</a>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className="hm-home-section">
            <h2 className="hm-home-section-title">Recent projects</h2>
            <div className="hm-home-projects">
              {[...projects]
                .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
                .slice(0, 6)
                .map((p) => (
                  <button
                    key={p.id}
                    className="hm-home-project-card"
                    onClick={() => onOpenProject(p.id)}
                  >
                    <span className="hm-home-project-name">{p.name}</span>
                    {p.description && (
                      <span className="hm-home-project-tag">{p.description.slice(0, 80)}</span>
                    )}
                    <span className="hm-home-project-foot">
                      {p.repo
                        ? <code>{p.repo}</code>
                        : <em>no repo linked</em>}
                      <span className="hm-home-project-when">{formatRelative(p.lastOpenedAt)}</span>
                    </span>
                  </button>
                ))}
            </div>
          </section>
        </>
      )}
    </div>
  )
}

function UsageCard() {
  const days     = useUsage((s) => s.days)
  const today    = summarise(days, 1)
  const sevenDay = summarise(days, 7)
  if (today.totalTokens === 0 && sevenDay.totalTokens === 0) return null
  const fmt$ = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`
  const fmtT = (n: number) => n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(2)}M`
    : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n)
  return (
    <section className="hm-home-section" style={{ marginBottom: 16 }}>
      <h2 className="hm-home-section-title">API spend (BYOK)</h2>
      <div className="hm-home-stats">
        <StatCard label="Today (tokens)"   value={fmtT(today.totalTokens)} />
        <StatCard label="Today (est $)"    value={fmt$(today.totalDollars)} tone={today.totalDollars > 5 ? 'gold' : undefined} />
        <StatCard label="7-day (tokens)"   value={fmtT(sevenDay.totalTokens)} />
        <StatCard label="7-day (est $)"    value={fmt$(sevenDay.totalDollars)} tone={sevenDay.totalDollars > 25 ? 'gold' : undefined} />
      </div>
      {Object.keys(today.byModel).length > 1 && (
        <p className="hm-home-empty" style={{ marginTop: 8, fontSize: 12 }}>
          Today by model: {Object.entries(today.byModel).map(([m, v]) =>
            `${m.replace('claude-', '').replace('-20251001', '')} ${fmt$(v.dollars)}`
          ).join(' · ')}
        </p>
      )}
    </section>
  )
}

function StatCard({
  label, value, tone,
}: { label: string; value: number | string; tone?: 'gold' }) {
  return (
    <div className={`hm-home-stat${tone === 'gold' ? ' is-gold' : ''}`}>
      <span className="hm-home-stat-value">{value}</span>
      <span className="hm-home-stat-label">{label}</span>
    </div>
  )
}

function parseDate(s: string | null | undefined): number {
  if (!s) return 0
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : 0
}

function formatRelative(ts: number): string {
  if (!ts) return '—'
  const diff = Date.now() - ts
  if (diff < 0) return 'just now'
  const m = Math.floor(diff / 60_000)
  if (m < 1)   return 'just now'
  if (m < 60)  return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24)  return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30)  return `${d}d ago`
  return new Date(ts).toLocaleDateString()
}
