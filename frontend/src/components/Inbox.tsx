/**
 * Inbox — single aggregated feed of "things that need your attention".
 *
 * Layer 2 of the AI builder roadmap. Aggregates from sources already
 * present in HM, no new API calls (so it doesn't burn budget):
 *
 *   • Failed task runs across all projects (centralised list endpoint)
 *   • gatetest.ai latest scan results stored in each repo's
 *     .holdenmercer/gatetest-latest.json (webhook-pushed)
 *   • Per-project readiness gaps (no brief, no invariants, no gate)
 *   • Recent crashes captured by ErrorBoundary in this browser session
 *
 * Each item gets:
 *   • severity (high / medium / low)
 *   • a one-line title and short body
 *   • a "Take action" CTA that jumps to the right tab / PR / fix path
 *   • a dismiss button (per-session for now; persistent in a follow-up)
 *
 * Future (Layer 2 phase 2): a daily cron Twin agent that scans every
 * project and posts proactive findings here ("you've reverted 3 commits
 * touching auth.tsx — architectural issue?", "this PR has been open 5
 * days with a red gate — abandon or fix?").
 */

import { useEffect, useMemo, useState } from 'react'
import { useProjects } from '../stores/projects'
import { useSettings } from '../stores/settings'
import { listTaskRuns, type TaskRun } from '../lib/jobs'
import { listDir } from '../lib/repo'

type Severity = 'high' | 'medium' | 'low'

interface InboxItem {
  id:       string
  severity: Severity
  title:    string
  body?:    string
  source:   'task' | 'gatetest' | 'readiness' | 'crash'
  ts:       number
  projectName?: string
  actionLabel?: string
  actionUrl?:   string
  /** Optional inline action — runs in the dashboard rather than navigating away. */
  onAction?: () => void
}

interface Props {
  onOpenProject?: (id: string) => void
}

export function Inbox({ onOpenProject }: Props = {}) {
  const projects  = useProjects((s) => s.projects)
  const setActive = useProjects((s) => s.setActive)
  const githubKey = useSettings((s) => s.githubToken)
  const linked    = useMemo(() => projects.filter((p) => !!p.repo), [projects])

  const [items, setItems] = useState<InboxItem[]>([])
  const [loading, setLoading] = useState(false)
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!githubKey || linked.length === 0) return
    let cancelled = false
    setLoading(true)
    ;(async () => {
      const out: InboxItem[] = []

      // 1. Failed task runs (cross-project, centralised list)
      try {
        const data = await listTaskRuns(linked[0].repo!, undefined)
        const fails = (data.runs as TaskRun[]).filter((r) =>
          r.status === 'completed'
          && r.conclusion
          && r.conclusion !== 'success'
          && r.conclusion !== 'skipped'
        ).slice(0, 5)
        for (const r of fails) {
          const ts = Date.parse(r.created_at ?? '') || 0
          out.push({
            id: `task-${r.id}`,
            severity: 'high',
            title: `Background task ${r.conclusion}`,
            body: `${r.name || 'Task'} on ${r.branch}. Open the run logs to see what blocked it.`,
            source: 'task',
            ts,
            actionLabel: 'Open run ↗',
            actionUrl: r.html_url,
          })
        }
      } catch { /* swallow — non-critical */ }

      // 2. Per-project readiness gaps
      for (const p of linked) {
        try {
          const hmDir = await listDir(p.repo!, '.holdenmercer', p.branch || undefined).catch(() => [])
          const ghDir = await listDir(p.repo!, '.github/workflows', p.branch || undefined).catch(() => [])
          if (!hmDir.some((f) => f.name === 'brief.md')) {
            out.push({
              id: `readiness-${p.id}-brief`,
              severity: 'medium',
              title: `${p.name}: no project brief`,
              body: 'Future Claude sessions will lack context. Write a brief on the Brief tab.',
              source: 'readiness',
              ts: Date.now() - 1000 * 60 * 60 * 24,
              projectName: p.name,
              actionLabel: 'Open Brief →',
              onAction: () => { setActive(p.id); onOpenProject?.(p.id) },
            })
          }
          if (!hmDir.some((f) => f.name === 'invariants.md')) {
            out.push({
              id: `readiness-${p.id}-invariants`,
              severity: 'low',
              title: `${p.name}: no invariants`,
              body: 'Things that must not break. Run 🪄 Onboard to auto-write, or add manually.',
              source: 'readiness',
              ts: Date.now() - 1000 * 60 * 60 * 24,
              projectName: p.name,
              actionLabel: 'Open project →',
              onAction: () => { setActive(p.id); onOpenProject?.(p.id) },
            })
          }
          if (!ghDir.some((f) => f.name === 'holden-mercer-gate.yml')) {
            out.push({
              id: `readiness-${p.id}-gate`,
              severity: 'high',
              title: `${p.name}: no gate workflow`,
              body: 'Without it, agents can merge red code. Click into the project and install it.',
              source: 'readiness',
              ts: Date.now() - 1000 * 60 * 60 * 24 * 2,
              projectName: p.name,
              actionLabel: 'Open Gate tab →',
              onAction: () => { setActive(p.id); onOpenProject?.(p.id) },
            })
          }
        } catch { /* swallow per-project */ }
      }

      // 3. Crash diagnostic (this browser session)
      try {
        const last = (window as unknown as Record<string, { message?: string; at?: string } | undefined>).__hmLastCrash
        if (last && last.message && last.at) {
          out.push({
            id: `crash-${last.at}`,
            severity: 'high',
            title: 'Dashboard crashed in this session',
            body: last.message.slice(0, 200),
            source: 'crash',
            ts: Date.parse(last.at) || Date.now(),
            actionLabel: 'See window.__hmLastCrash in DevTools',
          })
        }
      } catch { /* swallow */ }

      if (!cancelled) setItems(out.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || b.ts - a.ts))
      if (!cancelled) setLoading(false)
    })()
    return () => { cancelled = true }
  }, [linked, githubKey, tick, setActive, onOpenProject])

  const visible = items.filter((i) => !dismissed.has(i.id))

  return (
    <div className="hm-home">
      <header className="hm-home-header">
        <div>
          <h1 className="hm-home-title">Inbox</h1>
          <p className="hm-home-tagline">
            Everything across every project that needs your attention. Aggregated
            from gatetest.ai findings, failed tasks, missing brief/invariants/gate,
            and recent crashes. One place. One set of decisions.
          </p>
        </div>
        <div className="hm-home-actions">
          <button className="hm-btn-ghost" onClick={() => setTick((n) => n + 1)} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      {!githubKey && (
        <div className="hm-tasks-empty">
          Add a code-host PAT in Settings to scan projects.
        </div>
      )}

      {githubKey && visible.length === 0 && !loading && (
        <div className="hm-tasks-empty">
          <strong>Inbox zero.</strong> Nothing across your linked projects needs
          attention right now. Take a break.
        </div>
      )}

      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {visible.map((item) => {
          const sev = severityStyle(item.severity)
          return (
            <li
              key={item.id}
              style={{
                marginBottom: 10,
                padding: 12,
                borderRadius: 8,
                background: sev.bg,
                border: `1px solid ${sev.border}`,
                display: 'flex',
                gap: 12,
                alignItems: 'flex-start',
              }}
            >
              <span style={{ flexShrink: 0, fontSize: 18 }}>{sev.icon}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{item.title}</div>
                {item.body && (
                  <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 6 }}>
                    {item.body}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11, color: 'var(--text-muted)' }}>
                  <span style={{
                    padding: '1px 6px', borderRadius: 4,
                    background: 'rgba(255,255,255,0.05)',
                  }}>
                    {item.source}
                  </span>
                  {item.projectName && <span>· {item.projectName}</span>}
                  <span>· {formatRelative(item.ts)}</span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                {item.actionUrl && (
                  <a
                    className="hm-btn-ghost"
                    href={item.actionUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{ fontSize: 12 }}
                  >
                    {item.actionLabel ?? 'Open ↗'}
                  </a>
                )}
                {item.onAction && (
                  <button
                    className="hm-btn-ghost"
                    onClick={item.onAction}
                    style={{ fontSize: 12 }}
                  >
                    {item.actionLabel ?? 'Take action'}
                  </button>
                )}
                <button
                  className="hm-btn-ghost"
                  onClick={() => setDismissed((s) => new Set([...s, item.id]))}
                  title="Dismiss for this session (will reappear after refresh)"
                  style={{ fontSize: 12 }}
                >
                  Dismiss
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function severityRank(s: Severity): number {
  return s === 'high' ? 3 : s === 'medium' ? 2 : 1
}

function severityStyle(s: Severity): { bg: string; border: string; icon: string } {
  if (s === 'high')   return { bg: 'rgba(239,68,68,0.06)',  border: 'rgba(239,68,68,0.3)',  icon: '🔴' }
  if (s === 'medium') return { bg: 'rgba(234,179,8,0.06)',  border: 'rgba(234,179,8,0.3)',  icon: '🟡' }
  return                     { bg: 'rgba(99,102,241,0.05)', border: 'rgba(99,102,241,0.25)', icon: '🔵' }
}

function formatRelative(ts: number): string {
  if (!ts) return '—'
  const diff = Date.now() - ts
  if (diff < 0) return 'just now'
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(ts).toLocaleDateString()
}
