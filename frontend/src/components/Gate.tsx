/**
 * Gate tab — surfaces the project's GitHub Actions gate.
 *
 * The gate is a workflow we install at .github/workflows/holden-mercer-gate.yml
 * that runs lint + typecheck + tests on every push to working branches and on
 * workflow_dispatch. This tab lists the most recent runs, lets you trigger one
 * manually, view the logs of any failed run, and hand the failure straight to
 * Claude with the "Have Claude fix this" button — the self-repair loop.
 */

import { useCallback, useEffect, useState } from 'react'
import { useProjects } from '../stores/projects'
import { useChat } from '../stores/chat'
import { useSettings } from '../stores/settings'
import {
  gateLogs, listGateRuns, runGate, setupGate,
  type GateRun,
} from '../lib/gate'
import { scanRepo, type GatetestScanResult } from '../lib/gatetest'

interface Props {
  projectId: string
  /** Switches the parent ProjectShell over to the Console tab. */
  onSwitchToConsole: () => void
}

const STATUS_LABEL: Record<string, string> = {
  queued:      'queued',
  in_progress: 'running',
  completed:   'done',
}

export function Gate({ projectId, onSwitchToConsole }: Props) {
  const project = useProjects((s) => s.projects.find((p) => p.id === projectId))
  const setPendingInput = useChat((s) => s.setPendingInput)

  const [runs,      setRuns]      = useState<GateRun[]>([])
  const [installed, setInstalled] = useState(true)
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState<string | null>(null)
  const [busy,      setBusy]      = useState<string | null>(null)
  const [openLogs,  setOpenLogs]  = useState<number | null>(null)
  const [logs,      setLogs]      = useState<string>('')
  const [logsLoading, setLogsLoading] = useState(false)

  const repo   = project?.repo ?? null
  const branch = project?.branch ?? null

  const [refreshTick, setRefreshTick] = useState(0)
  const refresh = useCallback(() => setRefreshTick((n) => n + 1), [])

  useEffect(() => {
    if (!repo) return
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const data = await listGateRuns(repo, branch || undefined)
        if (cancelled) return
        setRuns(data.runs)
        setInstalled(data.workflow_installed)
      } catch (err) {
        if (!cancelled) setError((err as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [repo, branch, refreshTick])

  // Auto-poll while any run is queued/in_progress
  useEffect(() => {
    const stillRunning = runs.some((r) => r.status !== 'completed')
    if (!stillRunning) return
    const id = setInterval(refresh, 7_000)
    return () => clearInterval(id)
  }, [runs, refresh])

  if (!project) return null

  if (!repo) {
    return (
      <div className="hm-placeholder">
        <h2 className="hm-placeholder-title">No repo linked.</h2>
        <p className="hm-placeholder-body">
          The gate runs as a workflow in your project's repo. Click{' '}
          <strong>+ Link a repo</strong> above the tabs to set one up.
        </p>
      </div>
    )
  }

  const install = async () => {
    setBusy('install')
    setError(null)
    try {
      await setupGate(repo, branch || undefined)
      await refresh()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const trigger = async () => {
    setBusy('run')
    setError(null)
    try {
      await runGate(repo, branch || undefined)
      // The gate may take a moment to register; a few-second delay before
      // refreshing avoids showing an empty list on first run.
      setTimeout(refresh, 1500)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const viewLogs = async (run: GateRun) => {
    if (openLogs === run.id) {
      setOpenLogs(null)
      setLogs('')
      return
    }
    setOpenLogs(run.id)
    setLogsLoading(true)
    setLogs('')
    try {
      setLogs(await gateLogs(repo, run.id))
    } catch (err) {
      setLogs(`[error: ${(err as Error).message}]`)
    } finally {
      setLogsLoading(false)
    }
  }

  const handOff = async (run: GateRun) => {
    let runLogs = logs
    if (openLogs !== run.id || !runLogs) {
      try {
        runLogs = await gateLogs(repo, run.id)
      } catch (err) {
        setError((err as Error).message)
        return
      }
    }
    const trimmed = tailLines(runLogs, 200)
    setPendingInput(
      projectId,
      [
        `The Holden Mercer gate failed on run ${run.id} (${run.head_sha.slice(0, 7)} on ${run.branch}).`,
        '',
        'Failure log (last 200 lines):',
        '',
        '```',
        trimmed,
        '```',
        '',
        'Read what broke, propose a fix, commit it (write_github_file), then run_gate again to confirm.',
      ].join('\n'),
    )
    onSwitchToConsole()
  }

  return (
    <div className="hm-gate">
      <GatetestPanel repo={repo} />
      <header className="hm-gate-header">
        <div>
          <h2 className="hm-gate-title">Programmatic gate (GitHub Actions)</h2>
          <p className="hm-gate-help">
            Lint + typecheck + tests run on every push to working branches and
            on demand. Failures block the commit; Claude reads the log and
            self-repairs.
          </p>
        </div>
        <div className="hm-gate-actions">
          {!installed && (
            <button className="hm-btn-primary" onClick={install} disabled={busy !== null}>
              {busy === 'install' ? 'Installing…' : 'Install gate workflow'}
            </button>
          )}
          {installed && (
            <button className="hm-btn-primary" onClick={trigger} disabled={busy !== null}>
              {busy === 'run' ? 'Triggering…' : 'Run gate'}
            </button>
          )}
          <button className="hm-btn-ghost" onClick={refresh} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      {error && <div className="hm-memory-error">{error}</div>}

      {!installed && (
        <div className="hm-gate-empty">
          <p>
            The gate workflow isn't in this repo yet. Click <strong>Install gate
            workflow</strong> to commit{' '}
            <code>.github/workflows/holden-mercer-gate.yml</code>. It auto-detects
            Node and Python projects, runs your linter / typecheck / tests, and
            falls back to a custom <code>.holdenmercer/gate.sh</code> if you
            want full control.
          </p>
        </div>
      )}

      {installed && runs.length === 0 && !loading && (
        <div className="hm-gate-empty">
          <p>
            No runs yet. Click <strong>Run gate</strong> to fire one, or push to a{' '}
            <code>claude/*</code>, <code>holden/*</code>, or <code>hm/*</code> branch
            and the workflow runs automatically.
          </p>
        </div>
      )}

      <ul className="hm-gate-list">
        {runs.map((run) => {
          const concl = run.status === 'completed'
            ? (run.conclusion ?? 'unknown')
            : (STATUS_LABEL[run.status] ?? run.status)
          const ok = run.status === 'completed' && run.conclusion === 'success'
          const fail = run.status === 'completed' && run.conclusion && run.conclusion !== 'success' && run.conclusion !== 'skipped'

          return (
            <li key={run.id} className={`hm-gate-row${ok ? ' is-ok' : ''}${fail ? ' is-fail' : ''}`}>
              <div className="hm-gate-row-main">
                <span className="hm-gate-icon">
                  {ok ? '✅' : fail ? '❌' : '◌'}
                </span>
                <span className="hm-gate-row-meta">
                  <span className="hm-gate-row-title">{concl}</span>
                  <span className="hm-gate-row-sub">
                    <code>{run.branch}</code> · <code>{run.head_sha.slice(0, 7)}</code> · {run.event}
                    {run.actor ? ` · ${run.actor}` : ''} · {formatTime(run.created_at)}
                  </span>
                </span>
              </div>
              <div className="hm-gate-row-actions">
                {fail && (
                  <button className="hm-btn-primary" onClick={() => handOff(run)}>
                    Have Claude fix this
                  </button>
                )}
                <a className="hm-btn-ghost" href={run.html_url} target="_blank" rel="noreferrer">
                  Open ↗
                </a>
                {run.status === 'completed' && (
                  <button className="hm-btn-ghost" onClick={() => viewLogs(run)}>
                    {openLogs === run.id ? 'Hide logs' : 'View logs'}
                  </button>
                )}
              </div>
              {openLogs === run.id && (
                <pre className="hm-gate-logs">
                  {logsLoading ? 'Loading logs…' : logs}
                </pre>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function formatTime(iso: string | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function tailLines(text: string, max: number): string {
  const lines = text.split('\n')
  if (lines.length <= max) return text
  return ['[…earlier output trimmed…]', ...lines.slice(-max)].join('\n')
}

/**
 * GatetestPanel — gatetest.ai scanner integration.
 * Sits ABOVE the GHA gate panel. Only renders when a gatetest.ai key is
 * configured AND a repo is linked. One-click scan with quick / full tier
 * toggle. Failed modules expand inline; passed/skipped collapse.
 */
function GatetestPanel({ repo }: { repo: string | null }) {
  const gatetestKey = useSettings((s) => s.gatetestKey)
  const [tier, setTier]       = useState<'quick' | 'full'>('full')
  const [running, setRunning] = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [result, setResult]   = useState<GatetestScanResult | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  if (!gatetestKey || !repo) return null

  const run = async () => {
    setRunning(true)
    setError(null)
    try {
      const data = await scanRepo(repo, tier)
      setResult(data)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setRunning(false)
    }
  }

  const failed   = result?.modules?.filter((m) => m.status === 'failed') ?? []
  const skipped  = result?.modules?.filter((m) => m.status === 'skipped') ?? []
  const passed   = result?.modules?.filter((m) => m.status === 'passed') ?? []

  return (
    <section
      style={{
        marginBottom: 16, padding: 12,
        border: '1px solid var(--border, #2a2a2a)', borderRadius: 8,
        background: 'rgba(99,102,241,0.04)',
      }}
    >
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16 }}>🛡 gatetest.ai scanner</h2>
          <p style={{ margin: '4px 0 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
            Your own scanner — security · docs · compatibility · SEO. Runs against <code>{repo}</code>.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <select
            value={tier} onChange={(e) => setTier(e.target.value as 'quick' | 'full')}
            disabled={running}
            style={{
              padding: '4px 8px', borderRadius: 6,
              border: '1px solid var(--border, #444)',
              background: 'var(--bg-elev, #1a1a1a)', color: 'var(--text)', fontSize: 12,
            }}
          >
            <option value="quick">Quick (4 modules · ~10s)</option>
            <option value="full">Full (90 modules · up to 60s)</option>
          </select>
          <button className="hm-btn-primary" onClick={run} disabled={running}>
            {running ? 'Scanning…' : 'Run scan'}
          </button>
        </div>
      </header>

      {error && <div className="hm-memory-error" style={{ marginTop: 12 }}>{error}</div>}

      {result && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', gap: 16, fontSize: 13, marginBottom: 12 }}>
            <span><strong>{result.totalIssues}</strong> issues</span>
            <span style={{ color: 'var(--ok, #22c55e)' }}>✓ {passed.length} passed</span>
            <span style={{ color: 'var(--error, #ef4444)' }}>✗ {failed.length} failed</span>
            {skipped.length > 0 && <span style={{ color: 'var(--text-muted)' }}>· {skipped.length} skipped</span>}
            <span style={{ color: 'var(--text-muted)', marginLeft: 'auto' }}>
              {result.duration?.toFixed(1)}s · tier: {result.tier}
            </span>
          </div>

          {failed.map((m) => (
            <details
              key={m.name}
              open={expanded[m.name] ?? true}
              onToggle={(e) => setExpanded((s) => ({ ...s, [m.name]: (e.target as HTMLDetailsElement).open }))}
              style={{
                marginBottom: 8, padding: 8,
                background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.25)',
                borderRadius: 6,
              }}
            >
              <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--error)' }}>
                ✗ <strong>{m.name}</strong> · {m.issues ?? 0} issue{m.issues === 1 ? '' : 's'}
              </summary>
              {m.details && m.details.length > 0 && (
                <ul style={{ margin: '8px 0 0 0', paddingLeft: 20, fontSize: 12 }}>
                  {m.details.map((d, i) => <li key={i}>{d}</li>)}
                </ul>
              )}
            </details>
          ))}

          {(passed.length > 0 || skipped.length > 0) && (
            <details style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }}>
              <summary style={{ cursor: 'pointer' }}>
                {passed.length} passed, {skipped.length} skipped — click to expand
              </summary>
              <ul style={{ margin: '8px 0 0 0', paddingLeft: 20 }}>
                {passed.map((m) => <li key={m.name} style={{ color: 'var(--ok)' }}>✓ {m.name}</li>)}
                {skipped.map((m) => <li key={m.name}>· {m.name} (skipped)</li>)}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  )
}
