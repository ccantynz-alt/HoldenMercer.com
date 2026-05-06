/**
 * ProjectReadiness — slim row of status pills above the project tabs.
 *
 * Tells you at a glance whether a project is fully wired:
 *   • Repo linked
 *   • Brief written (.holdenmercer/brief.md present in repo)
 *   • Invariants written (.holdenmercer/invariants.md)
 *   • Gate workflow installed (.github/workflows/holden-mercer-gate.yml)
 *   • Last gate run status (✅ / ❌ / ◌ in-progress / · never)
 *
 * Click any non-green pill → opens the relevant tab or runs the relevant
 * one-click fix. This is the per-project complement to the admin-level
 * SetupReadinessCard on AdminHome.
 *
 * Designed to fade out (auto-collapse) once everything's green so it
 * doesn't clutter the project shell header for fully-onboarded projects.
 */

import { useEffect, useState } from 'react'
import { useProjects } from '../stores/projects'
import { listDir } from '../lib/repo'
import { listGateRuns } from '../lib/gate'

interface Props {
  projectId: string
  onJumpToTab?: (tab: 'brief' | 'gate' | 'tasks') => void
}

type Pill = { id: string; label: string; status: 'ok' | 'warn' | 'fail' | 'unknown'; tip: string; action?: () => void }

export function ProjectReadiness({ projectId, onJumpToTab }: Props) {
  const project = useProjects((s) => s.projects.find((p) => p.id === projectId))

  const [hasBrief,      setHasBrief]      = useState<boolean | null>(null)
  const [hasInvariants, setHasInvariants] = useState<boolean | null>(null)
  const [hasGate,       setHasGate]       = useState<boolean | null>(null)
  const [lastGate,      setLastGate]      = useState<'ok' | 'fail' | 'pending' | null>(null)
  const [collapsed,     setCollapsed]     = useState(false)

  useEffect(() => {
    if (!project?.repo) return
    let cancelled = false
    const repo   = project.repo
    const branch = project.branch || undefined

    ;(async () => {
      try {
        const [hmDir, ghDir, gateData] = await Promise.all([
          listDir(repo, '.holdenmercer', branch).catch(() => []),
          listDir(repo, '.github/workflows', branch).catch(() => []),
          listGateRuns(repo, branch).catch(() => ({ runs: [], workflow_installed: false })),
        ])
        if (cancelled) return
        setHasBrief(hmDir.some((f) => f.name === 'brief.md'))
        setHasInvariants(hmDir.some((f) => f.name === 'invariants.md'))
        setHasGate(ghDir.some((f) => f.name === 'holden-mercer-gate.yml'))
        const recent = gateData.runs[0]
        if (!recent) setLastGate(null)
        else if (recent.status !== 'completed') setLastGate('pending')
        else setLastGate(recent.conclusion === 'success' ? 'ok' : 'fail')
      } catch { /* swallow — readiness is informational */ }
    })()
    return () => { cancelled = true }
  }, [project?.repo, project?.branch])

  if (!project?.repo) return null

  const pills: Pill[] = [
    {
      id: 'brief',
      label: 'Brief',
      status: hasBrief === null ? 'unknown' : hasBrief ? 'ok' : 'warn',
      tip: hasBrief ? '.holdenmercer/brief.md ✓' : 'No brief in repo. Click to write one.',
      action: () => onJumpToTab?.('brief'),
    },
    {
      id: 'invariants',
      label: 'Invariants',
      status: hasInvariants === null ? 'unknown' : hasInvariants ? 'ok' : 'warn',
      tip: hasInvariants
        ? '.holdenmercer/invariants.md ✓'
        : 'No invariants. Run 🪄 Onboard to auto-write, or add manually.',
    },
    {
      id: 'gate',
      label: 'Gate',
      status: hasGate === null ? 'unknown' : hasGate ? 'ok' : 'fail',
      tip: hasGate
        ? 'Gate workflow installed. Catches regressions on every change.'
        : 'No gate workflow. Without it, agents can merge red code. Click to install.',
      action: () => onJumpToTab?.('gate'),
    },
    {
      id: 'lastgate',
      label: 'Last run',
      status:
        lastGate === 'ok'      ? 'ok'
        : lastGate === 'fail'  ? 'fail'
        : lastGate === 'pending' ? 'warn'
        : 'unknown',
      tip:
        lastGate === 'ok'      ? 'Last gate run was green. Safe to ship.'
        : lastGate === 'fail'  ? 'Last gate run failed. Click to investigate.'
        : lastGate === 'pending' ? 'Gate is currently running.'
        : 'No recent gate runs.',
      action: () => onJumpToTab?.('gate'),
    },
  ]

  const allGreen = pills.every((p) => p.status === 'ok' || p.status === 'unknown')

  if (collapsed || allGreen) return null

  return (
    <div
      style={{
        display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center',
        padding: '8px 0', marginBottom: 8,
      }}
    >
      <span style={{ fontSize: 12, color: 'var(--text-muted)', marginRight: 4 }}>
        Readiness:
      </span>
      {pills.map((p) => (
        <button
          key={p.id}
          onClick={p.action}
          title={p.tip}
          disabled={!p.action}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '2px 8px', borderRadius: 12, fontSize: 12,
            border: '1px solid var(--border, #2a2a2a)',
            background:
              p.status === 'ok'      ? 'rgba(34,197,94,0.10)'
              : p.status === 'warn'  ? 'rgba(234,179,8,0.10)'
              : p.status === 'fail'  ? 'rgba(239,68,68,0.10)'
              : 'transparent',
            color:
              p.status === 'ok'      ? 'var(--ok, #22c55e)'
              : p.status === 'warn'  ? 'var(--warn, #eab308)'
              : p.status === 'fail'  ? 'var(--error, #ef4444)'
              : 'var(--text-muted)',
            cursor: p.action ? 'pointer' : 'default',
          }}
        >
          <span>
            {p.status === 'ok' ? '✓' : p.status === 'warn' ? '!' : p.status === 'fail' ? '✗' : '·'}
          </span>
          {p.label}
        </button>
      ))}
      <button
        onClick={() => setCollapsed(true)}
        style={{
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: 'var(--text-muted)', fontSize: 12, marginLeft: 'auto',
        }}
        title="Hide readiness for this session"
      >
        ×
      </button>
    </div>
  )
}
