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
import { scanRepo, type GatetestScanResult, type GatetestModule } from '../lib/gatetest'
import { dispatchTask, listTaskRuns, fetchRunLogs, type TaskRun } from '../lib/jobs'
import { estimateTaskCost } from '../stores/usage'
import { toast } from '../stores/toast'
import { checkDispatch, effectiveDispatchModel } from '../lib/dispatchGuard'

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

  // Auto-poll while any run is queued/in_progress. If the underlying fetch
  // fails (transient or auth), we want the error to surface — refresh()
  // already routes through the same useEffect that sets `error`, so the
  // user sees what's happening instead of staring at a stuck spinner.
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
      <details
        style={{
          marginTop: 16,
          padding: 12,
          border: '1px solid var(--border, #2a2a2a)',
          borderRadius: 8,
          background: 'var(--bg-elev, rgba(255,255,255,0.02))',
        }}
      >
        <summary
          style={{
            cursor: 'pointer',
            fontSize: 14,
            color: 'var(--text-muted, #888)',
            userSelect: 'none',
          }}
        >
          Advanced — GitHub Actions gate (legacy fallback)
        </summary>
        <div style={{ marginTop: 12 }}>
      <header className="hm-gate-header">
        <div>
          <h2 className="hm-gate-title">Programmatic gate (GitHub Actions)</h2>
          <p className="hm-gate-help">
            Lint + typecheck + tests via GitHub Actions. Lighter-weight than
            gatetest.ai (above) but still a useful belt-and-suspenders for
            commits Claude makes on working branches. The primary signal
            should be gatetest.ai.
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
      </details>
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
  const autoFix     = useSettings((s) => s.autoFixGatetest)
  const defaultModel = useSettings((s) => s.defaultModel)
  const [tier, setTier]       = useState<'quick' | 'full'>('full')
  const [running, setRunning] = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [result, setResult]   = useState<GatetestScanResult | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [dispatching, setDispatching] = useState<string | null>(null)
  const [autoDispatched, setAutoDispatched] = useState<string | null>(null)
  /** Live "fix in progress" state — when set, the panel shows inline
   *  progress + agent logs + auto-rescans when the run completes. */
  const [activeFix, setActiveFix] = useState<{
    taskId: string
    runId:  number | null
    status: 'queued' | 'in_progress' | 'completed' | 'unknown'
    conclusion: string | null
    startedAt: number
    logs: string
    moduleNames: string[]    // which findings this fix targeted
  } | null>(null)
  /** Snapshot of findings before the fix dispatched. Used to render
   *  "✓ resolved" badges on findings that disappeared between scans. */
  const [previousFailedNames, setPreviousFailedNames] = useState<string[]>([])

  if (!gatetestKey || !repo) return null

  // Live fix monitor — polls task status + streams logs while a fix runs.
  // When the task completes, auto-runs a fresh gatetest scan so the user
  // sees the panel update without clicking anything.
  useEffect(() => {
    if (!activeFix || activeFix.status === 'completed') return
    let cancelled = false
    const tick = async () => {
      try {
        // Find the matching task run from the central HM repo's task list.
        const runs = (await listTaskRuns(repo, undefined)).runs as TaskRun[]
        // Match by either runId (if we already discovered it) OR by branch
        // pattern containing the task_id (the agent runs on claude/* and
        // the central workflow doesn't expose task_id directly in run
        // metadata — we match on what we can).
        const match = activeFix.runId
          ? runs.find((r) => r.id === activeFix.runId)
          : runs.find((r) => r.branch && r.branch.startsWith('claude/')) || runs[0]
        if (!match) return

        // Pull live logs for the matched run
        let logs = activeFix.logs
        try {
          const logsResp = await fetchRunLogs(match.id)
          logs = logsResp.logs || logs
        } catch { /* swallow — keep last logs */ }

        if (cancelled) return
        const status: 'queued' | 'in_progress' | 'completed' | 'unknown' =
          match.status === 'queued'      ? 'queued'
          : match.status === 'in_progress' ? 'in_progress'
          : match.status === 'completed' ? 'completed'
          : 'unknown'
        setActiveFix((prev) => prev ? {
          ...prev,
          runId:      match.id,
          status,
          conclusion: match.conclusion,
          logs,
        } : prev)

        // On completion, fire a fresh gatetest scan after a short delay
        // (give GitHub a beat to finalise the merged PR).
        if (status === 'completed') {
          setTimeout(() => { if (!cancelled) run() }, 4000)
        }
      } catch { /* swallow tick errors */ }
    }
    tick()
    const id = setInterval(tick, 5000)
    return () => { cancelled = true; clearInterval(id) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFix?.taskId])

  const run = async () => {
    setRunning(true)
    setError(null)
    setAutoDispatched(null)
    try {
      const data = await scanRepo(repo, tier)
      setResult(data)

      // Autonomous loop: if there are failures AND the user has opted into
      // auto-fix, dispatch the auto-fix task immediately. The user sees a
      // banner saying it fired so they're not surprised.
      const failedNow = (data.modules || []).filter((m) => m.status === 'failed')
      if (autoFix && failedNow.length > 0) {
        const plan = { model: '', maxIters: 25, forceHaiku: true }
        const blocked = checkDispatch(plan)
        if (blocked) {
          toast('error', 'Auto-fix dispatch blocked', blocked)
        } else {
          try {
            const dispatched = await dispatchTask({
              repo,
              prompt:    fixAllPrompt(repo, failedNow, tier),
              brief:     `Auto-fix dispatched on failed gatetest.ai scan — ${failedNow.length} module(s).`,
              model:     effectiveDispatchModel(plan),
              max_iters: plan.maxIters,
            })
            setAutoDispatched(dispatched.task_id)
            setPreviousFailedNames(failedNow.map((m) => m.name))
            setActiveFix({
              taskId:      dispatched.task_id,
              runId:       null,
              status:      'queued',
              conclusion:  null,
              startedAt:   Date.now(),
              logs:        '',
              moduleNames: failedNow.map((m) => m.name),
            })
          } catch (autoErr) {
            setError(`Auto-fix failed to dispatch: ${(autoErr as Error).message}`)
          }
        }
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setRunning(false)
    }
  }

  /** Fix one module via a tightly-scoped background task. Loops out to the
   *  agent runner; agent reads the module's findings, fixes ONLY that scope,
   *  opens a PR, gate validates. */
  const fixOne = async (m: GatetestModule) => {
    if (!repo) return
    // GUARD: kill switch + daily cap. Force Haiku for fix tasks so cost is
    // predictable regardless of user's defaultModel setting.
    const plan = { model: '', maxIters: 20, forceHaiku: true }
    const blocked = checkDispatch(plan)
    if (blocked) {
      toast('error', 'Dispatch blocked', blocked)
      return
    }
    setDispatching(m.name)
    try {
      const globalPrefs = useSettings.getState().globalPrefs
      const briefPrefix = globalPrefs.trim()
        ? `User's global preferences (apply to ALL projects):\n${globalPrefs.trim()}\n\n---\n\n`
        : ''
      const dispatched = await dispatchTask({
        repo,
        prompt:    fixModulePrompt(repo, m, tier),
        brief:     briefPrefix + `gatetest.ai found ${m.issues ?? 0} issue(s) in module "${m.name}" — auto-repair task dispatched from HM Gate tab.`,
        model:     effectiveDispatchModel(plan),
        max_iters: plan.maxIters,
      })
      // Snapshot which modules are failing right now so we can render
      // ✓ resolved badges after the fix re-runs the scan.
      setPreviousFailedNames((result?.modules || []).filter((x) => x.status === 'failed').map((x) => x.name))
      setActiveFix({
        taskId:      dispatched.task_id,
        runId:       null,
        status:      'queued',
        conclusion:  null,
        startedAt:   Date.now(),
        logs:        '',
        moduleNames: [m.name],
      })
      toast(
        'success',
        `Fix dispatched for "${m.name}"`,
        `Watch live progress on this panel. Auto-rescans when done.`
      )
    } catch (err) {
      setError(`Fix dispatch failed: ${(err as Error).message}`)
    } finally {
      setDispatching(null)
    }
  }

  /** Fix ALL failed modules in ONE task. Cheaper than dispatching N tasks
   *  (one cached system prompt; one branch + one PR; less collision risk). */
  const fixAll = async (failedModules: GatetestModule[]) => {
    if (!repo) return
    // GUARD: kill switch + daily cap. Force Haiku so spend is bounded;
    // reduced max_iters from 50→25 (the runaway-cost vector that burned
    // the user's $50 was iter-50 Opus tasks).
    const plan = { model: '', maxIters: 25, forceHaiku: true }
    const blocked = checkDispatch(plan)
    if (blocked) {
      toast('error', 'Dispatch blocked', blocked)
      return
    }
    setDispatching('__all__')
    try {
      const globalPrefs = useSettings.getState().globalPrefs
      const briefPrefix = globalPrefs.trim()
        ? `User's global preferences (apply to ALL projects):\n${globalPrefs.trim()}\n\n---\n\n`
        : ''
      const dispatched = await dispatchTask({
        repo,
        prompt:    fixAllPrompt(repo, failedModules, tier),
        brief:     briefPrefix + `gatetest.ai found ${failedModules.length} failed modules — auto-repair task dispatched from HM Gate tab.`,
        model:     effectiveDispatchModel(plan),
        max_iters: plan.maxIters,
      })
      setPreviousFailedNames(failedModules.map((m) => m.name))
      setActiveFix({
        taskId:      dispatched.task_id,
        runId:       null,
        status:      'queued',
        conclusion:  null,
        startedAt:   Date.now(),
        logs:        '',
        moduleNames: failedModules.map((m) => m.name),
      })
      toast(
        'success',
        `Auto-fix dispatched for ${failedModules.length} module${failedModules.length === 1 ? '' : 's'}`,
        `Watch live progress on this panel. Auto-rescans when done.`
      )
    } catch (err) {
      setError(`Auto-fix dispatch failed: ${(err as Error).message}`)
    } finally {
      setDispatching(null)
    }
  }

  const failed   = result?.modules?.filter((m) => m.status === 'failed') ?? []
  const skipped  = result?.modules?.filter((m) => m.status === 'skipped') ?? []
  const passed   = result?.modules?.filter((m) => m.status === 'passed') ?? []

  return (
    <section className={`hm-ai-card${running ? ' is-running' : ''}`}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <div style={{ minWidth: 0 }}>
          <h2 className="hm-ai-title">
            <span className="hm-ai-status-dot" aria-hidden />
            gatetest.ai scanner
          </h2>
          <p className="hm-ai-subtitle">
            Your own scanner — security · docs · compatibility · SEO. Runs against <code>{repo}</code>.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flex: '0 0 auto' }}>
          {running && (
            <span className="hm-ai-running" aria-live="polite">
              <span>scanning<span className="hm-ai-running-dots" /></span>
            </span>
          )}
          <select
            className="hm-ai-select"
            value={tier}
            onChange={(e) => setTier(e.target.value as 'quick' | 'full')}
            disabled={running}
          >
            <option value="quick">Quick · 4 modules · ~10s</option>
            <option value="full">Full · 90 modules · up to 60s</option>
          </select>
          <button
            className="hm-btn-primary hm-btn-glow"
            onClick={run}
            disabled={running}
          >
            {running ? 'Scanning' : 'Run scan'}
          </button>
        </div>
      </header>

      {error && <div className="hm-ai-error">{error}</div>}

      {autoDispatched && !activeFix && (
        <div className="hm-ai-banner">
          🔧 <strong>Auto-fix dispatched</strong> — task <code>{autoDispatched}</code>.
          Watch progress in the Tasks tab → 📜 Logs. The agent will iterate
          fix → scan → fix until green or it surfaces stubborn failures.
        </div>
      )}

      {activeFix && (
        <LiveFixProgress
          fix={activeFix}
          onDismiss={() => setActiveFix(null)}
          previousFailedNames={previousFailedNames}
          currentFailedNames={(result?.modules || []).filter((m) => m.status === 'failed').map((m) => m.name)}
        />
      )}

      {result && (
        <div>
          <div className="hm-ai-stats">
            <span className="hm-ai-stat"><strong>{result.totalIssues}</strong>&nbsp;issues</span>
            <span className="hm-ai-stat is-ok">✓ {passed.length} passed</span>
            <span className="hm-ai-stat is-fail">✗ {failed.length} failed</span>
            {skipped.length > 0 && (
              <span className="hm-ai-stat">· {skipped.length} skipped</span>
            )}
            <span className="hm-ai-stat-meta">
              {result.duration?.toFixed(1)}s · tier: {result.tier}
            </span>
            {failed.length > 0 && (
              <>
                <span
                  style={{
                    marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)',
                  }}
                  title={estimateTaskCost(defaultModel, 50).notes}
                >
                  ≈ {(() => {
                    const d = estimateTaskCost(defaultModel, 50).estimatedDollars
                    return d < 0.01 ? '<$0.01' : `$${d.toFixed(d < 1 ? 3 : 2)}`
                  })()} forecast
                </span>
                <button
                  className="hm-btn-primary"
                  onClick={() => fixAll(failed)}
                  disabled={dispatching !== null}
                  title={`Dispatch ONE background task to fix all ${failed.length} failed modules. Branch + PR + gate-protected merge.`}
                >
                  {dispatching === '__all__'
                    ? 'Dispatching…'
                    : `🔧 Auto-fix all ${failed.length} failures`}
                </button>
              </>
            )}
          </div>

          {/* "Resolved this run" — modules that were failing before the
              auto-fix dispatch but are now passing. Acknowledgment that the
              loop actually did something. */}
          {previousFailedNames.length > 0 && (() => {
            const currentFailed = new Set(failed.map((m) => m.name))
            const resolved = previousFailedNames.filter((n) => !currentFailed.has(n))
            if (resolved.length === 0) return null
            return (
              <div
                style={{
                  marginTop: 12, padding: 8,
                  background: 'rgba(34,197,94,0.08)',
                  border: '1px solid rgba(34,197,94,0.3)',
                  borderRadius: 6, fontSize: 13,
                }}
              >
                <strong style={{ color: 'var(--ok, #22c55e)' }}>
                  ✓ Resolved this run ({resolved.length})
                </strong>
                <ul style={{ margin: '6px 0 0 20px', padding: 0 }}>
                  {resolved.map((n) => (
                    <li key={n} style={{ color: 'var(--ok, #22c55e)' }}>{n}</li>
                  ))}
                </ul>
              </div>
            )
          })()}

          <div style={{ marginTop: 12 }}>
            {failed.map((m) => (
              <details
                key={m.name}
                className="hm-ai-fail"
                open={expanded[m.name] ?? true}
                onToggle={(e) => setExpanded((s) => ({ ...s, [m.name]: (e.target as HTMLDetailsElement).open }))}
              >
                <summary>
                  <span className="hm-ai-fail-name">
                    ✗ <strong>{m.name}</strong> · {m.issues ?? 0} issue{m.issues === 1 ? '' : 's'}
                  </span>
                  <button
                    className="hm-btn-ghost"
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); fixOne(m) }}
                    disabled={dispatching !== null}
                    title={`Dispatch a focused background task to fix only "${m.name}". Branch + PR + gate-protected merge.`}
                    style={{ fontSize: 11 }}
                  >
                    {dispatching === m.name ? 'Dispatching…' : '🔧 Have Claude fix this'}
                  </button>
                </summary>
                {m.details && m.details.length > 0 && (
                  <ul style={{ margin: '8px 0 0 20px', fontSize: 12, color: 'var(--text-secondary)' }}>
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
                <ul style={{ margin: '8px 0 0 20px' }}>
                  {passed.map((m) => <li key={m.name} style={{ color: '#0f7e5e' }}>✓ {m.name}</li>)}
                  {skipped.map((m) => <li key={m.name}>· {m.name} (skipped)</li>)}
                </ul>
              </details>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

// ── Prompt builders for the gatetest.ai self-repair loop ────────────────────

function fixModulePrompt(repo: string, m: GatetestModule, tier: string): string {
  const detailsBlock = (m.details && m.details.length > 0)
    ? '\nSpecific findings:\n' + m.details.map((d) => `  • ${d}`).join('\n')
    : ''
  return `Self-repair task — gatetest.ai found issues in this repo.

Target repo: ${repo}
Failed module: "${m.name}"
Issues count: ${m.issues ?? 'unknown'}
gatetest.ai tier when scanned: ${tier}
${detailsBlock}

DOCTRINE (binding):
  • Branch + PR + gate-protected merge — never commit to main directly
  • Read flywheel context FIRST (check_recent_activity)
  • claim_work BEFORE editing
  • Keep your scope TIGHT — fix ONLY the "${m.name}" findings. Don't drift.
    If you spot something else worth fixing, note it in the PR body but
    DO NOT touch it in this PR.
  • Maintain ALL invariants in .holdenmercer/invariants.md if present
  • After committing fixes, dispatch a fresh gatetest.ai scan via the
    /api/gatetest/scan endpoint (or by clicking Run scan in HM) to confirm
    the "${m.name}" module now passes. If it doesn't, iterate on the same
    branch with another commit + scan, up to a reasonable limit. The PR
    only merges if the gate is green.

When done: report_result with a one-paragraph summary covering:
  • What was wrong (root cause, in your words)
  • What you changed (files + the actual fix)
  • Final scan result for "${m.name}" — passed / still failing
  • The PR URL`
}

function fixAllPrompt(repo: string, modules: GatetestModule[], tier: string): string {
  const blocks = modules.map((m) => {
    const det = (m.details && m.details.length > 0)
      ? '\n    Findings:\n' + m.details.map((d) => `      • ${d}`).join('\n')
      : ''
    return `  - ${m.name} (${m.issues ?? 0} issues)${det}`
  }).join('\n')

  return `Self-repair task — gatetest.ai found ${modules.length} failed modules.

Target repo: ${repo}
gatetest.ai tier when scanned: ${tier}

Failed modules + findings:
${blocks}

DOCTRINE (binding):
  • Branch + PR + gate-protected merge — never commit to main directly
  • Read flywheel context FIRST (check_recent_activity)
  • claim_work BEFORE editing
  • One PR for all fixes — group commits logically (one commit per module
    where possible). Don't open ${modules.length} separate PRs.
  • Address EACH module above. Don't pick favourites or skip the hard ones.
  • Maintain ALL invariants in .holdenmercer/invariants.md if present
  • After committing all fixes, dispatch a fresh gatetest.ai scan to
    verify every previously-failed module now passes. If any still fail,
    iterate on the same branch — up to ~3 fix-then-scan cycles before
    surfacing what's stubborn for the user to look at.
  • The PR only merges if the gate is green.

When done: report_result with one paragraph covering:
  • What you changed across all modules (one bullet per module)
  • Final gatetest.ai scan result — how many of the ${modules.length}
    modules now pass; if any still fail, name them + why
  • The PR URL`
}

/**
 * LiveFixProgress — inline live view of a fix-in-flight.
 *
 * Shows: status icon, time elapsed, list of targeted modules with
 * per-module ✓ once they're resolved (compared to currentFailedNames),
 * tail of agent logs, and a dismiss button.
 *
 * The user sees the panel come alive instead of staring at a static
 * list and wondering whether anything's happening.
 */
function LiveFixProgress({ fix, onDismiss, previousFailedNames, currentFailedNames }: {
  fix: {
    taskId: string
    runId:  number | null
    status: 'queued' | 'in_progress' | 'completed' | 'unknown'
    conclusion: string | null
    startedAt: number
    logs: string
    moduleNames: string[]
  }
  onDismiss: () => void
  previousFailedNames: string[]
  currentFailedNames:  string[]
}) {
  const elapsedSec = Math.floor((Date.now() - fix.startedAt) / 1000)
  const elapsedLabel = elapsedSec < 60
    ? `${elapsedSec}s`
    : `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`

  const isDone   = fix.status === 'completed'
  const isOk     = isDone && fix.conclusion === 'success'
  const isFailed = isDone && fix.conclusion && fix.conclusion !== 'success' && fix.conclusion !== 'skipped'

  const headerColor = isFailed ? 'var(--error, #ef4444)' : isOk ? 'var(--ok, #22c55e)' : 'var(--warn, #eab308)'
  const headerBg = isFailed ? 'rgba(239,68,68,0.08)' : isOk ? 'rgba(34,197,94,0.08)' : 'rgba(234,179,8,0.08)'
  const icon = isOk ? '✅' : isFailed ? '❌' : fix.status === 'queued' ? '◌' : '◌'
  const headline = isOk
    ? `Repair complete — re-scanning…`
    : isFailed
    ? `Repair task ${fix.conclusion}`
    : fix.status === 'queued'
    ? `Repair queued — workflow starting…`
    : `Repair in progress`

  // Per-module status: resolved (was failing in prev scan, not in current),
  // pending (still failing in current scan), or unknown if no current scan yet.
  const currentSet = new Set(currentFailedNames)
  const wasFailingSet = new Set(previousFailedNames)
  const moduleStatus = (name: string): 'resolved' | 'pending' | 'unknown' => {
    if (!wasFailingSet.has(name)) return 'unknown'
    return currentSet.has(name) ? 'pending' : 'resolved'
  }

  // Tail of logs (last 60 lines) — keeps the view from getting overwhelming
  // while still feeling alive.
  const logTail = (() => {
    if (!fix.logs) return ''
    const lines = fix.logs.split('\n')
    if (lines.length <= 60) return fix.logs
    return ['[…earlier output trimmed…]', ...lines.slice(-60)].join('\n')
  })()

  return (
    <section
      style={{
        marginTop: 12, marginBottom: 16, padding: 12,
        background: headerBg, border: `1px solid ${headerColor}`,
        borderRadius: 8,
      }}
    >
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <span>
          <span style={{ marginRight: 8 }}>{icon}</span>
          <strong style={{ color: headerColor }}>{headline}</strong>
          <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--text-muted)' }}>
            {fix.status} · {elapsedLabel}
            {fix.taskId && <> · <code style={{ fontSize: 11 }}>{fix.taskId}</code></>}
          </span>
        </span>
        <button
          onClick={onDismiss}
          style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: 'var(--text-muted)', fontSize: 18, lineHeight: 1, padding: 0,
          }}
          title="Dismiss this view (the task continues running in the background)"
        >
          ×
        </button>
      </header>

      {fix.moduleNames.length > 0 && (
        <ul style={{ margin: '8px 0 0 0', padding: 0, listStyle: 'none', fontSize: 13 }}>
          {fix.moduleNames.map((n) => {
            const s = moduleStatus(n)
            const dot = s === 'resolved' ? '✓' : s === 'pending' ? '◌' : '·'
            const color = s === 'resolved' ? 'var(--ok, #22c55e)' : s === 'pending' ? 'var(--warn, #eab308)' : 'var(--text-muted)'
            const label = s === 'resolved' ? 'resolved' : s === 'pending' ? 'still failing' : 'pending re-scan'
            return (
              <li key={n} style={{ color, padding: '2px 0' }}>
                <span style={{ marginRight: 6 }}>{dot}</span>
                <strong>{n}</strong>
                <span style={{ marginLeft: 8, fontSize: 11, opacity: 0.8 }}>{label}</span>
              </li>
            )
          })}
        </ul>
      )}

      {logTail && (
        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text-muted)' }}>
            Live agent logs ({fix.logs.length.toLocaleString()} chars · auto-refreshes every 5s)
          </summary>
          <pre style={{
            margin: '6px 0 0 0', padding: 10,
            background: 'var(--bg, #0a0a0b)',
            color: 'var(--text, #ddd)',
            fontSize: 11, lineHeight: 1.4,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            maxHeight: '40vh', overflow: 'auto',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            borderRadius: 6,
          }}>
            {logTail}
          </pre>
        </details>
      )}
    </section>
  )
}
