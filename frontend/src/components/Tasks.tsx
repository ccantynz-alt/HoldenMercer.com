/**
 * Tasks tab — background agents.
 *
 * The dashboard dispatches a Holden Mercer task workflow in the project's
 * repo. The workflow runs an agent inside GitHub Actions for up to 6 hours,
 * commits work, and writes a result file. This tab lists recent runs,
 * polls them while they're in progress, and shows the result once they
 * finish.
 *
 * Differs from the Gate tab in that the runs are AGENTS doing work, not
 * the test harness checking work — but the underlying GHA primitives are
 * the same.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useProjects } from '../stores/projects'
import {
  fetchTaskResult, listTaskRuns, setupTaskWorkflow,
  type TaskRun,
} from '../lib/jobs'
import { notify, permission } from '../lib/notify'

interface Props {
  projectId: string
}

const STATUS_LABEL: Record<string, string> = {
  queued:      'queued',
  in_progress: 'running',
  completed:   'done',
}

export function Tasks({ projectId }: Props) {
  const project = useProjects((s) => s.projects.find((p) => p.id === projectId))

  const [runs,      setRuns]      = useState<TaskRun[]>([])
  const [installed, setInstalled] = useState(true)
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState<string | null>(null)
  const [busy,      setBusy]      = useState<string | null>(null)
  const [openRun,   setOpenRun]   = useState<number | null>(null)
  const [openRunResult, setOpenRunResult] = useState<string | null>(null)
  const [resultLoading, setResultLoading] = useState(false)
  const [secretsUrl, setSecretsUrl] = useState<string | null>(null)

  // Track last-known status per run so we can fire one notification on
  // the in_progress → completed transition without spamming on every poll.
  const lastStatusRef = useRef<Record<number, string>>({})
  // Skip notifying on the first poll after a project is opened (otherwise
  // every previously-completed run notifies us all over again).
  const initialRef = useRef(true)

  const repo   = project?.repo ?? null
  const branch = project?.branch ?? null

  const refresh = useMemo(() => async () => {
    if (!repo) return
    setLoading(true)
    setError(null)
    try {
      const data = await listTaskRuns(repo, branch || undefined)
      setRuns(data.runs)
      setInstalled(data.workflow_installed)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [repo, branch])

  useEffect(() => { refresh() }, [refresh])

  // Poll while any run is in progress
  useEffect(() => {
    const stillRunning = runs.some((r) => r.status !== 'completed')
    if (!stillRunning) return
    const id = setInterval(refresh, 10_000)
    return () => clearInterval(id)
  }, [runs, refresh])

  // Fire notifications on in_progress → completed transitions
  useEffect(() => {
    if (initialRef.current) {
      // Seed last-known statuses without notifying on the first load
      runs.forEach((r) => { lastStatusRef.current[r.id] = r.status })
      initialRef.current = false
      return
    }
    if (permission() !== 'granted' || !project) return
    for (const run of runs) {
      const prev = lastStatusRef.current[run.id]
      lastStatusRef.current[run.id] = run.status
      if (prev && prev !== 'completed' && run.status === 'completed') {
        const ok = run.conclusion === 'success'
        notify({
          title: ok
            ? `✅ ${project.name} — task done`
            : `❌ ${project.name} — task ${run.conclusion ?? 'failed'}`,
          body:  run.name?.slice(0, 200),
          url:   run.html_url,
          tag:   `hm-task-${run.id}`,
        })
      }
    }
  }, [runs, project])

  if (!project) return null

  if (!repo) {
    return (
      <div className="hm-placeholder">
        <h2 className="hm-placeholder-title">No repo linked.</h2>
        <p className="hm-placeholder-body">
          Background tasks run as GitHub Actions in your project's repo. Click{' '}
          <strong>+ Link a GitHub repo</strong> above the tabs to set one up.
        </p>
      </div>
    )
  }

  const install = async () => {
    setBusy('install')
    setError(null)
    setSecretsUrl(null)
    try {
      const data = await setupTaskWorkflow(repo, branch || undefined)
      setSecretsUrl(data.secret_setup_url)
      await refresh()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const viewRun = async (run: TaskRun) => {
    if (openRun === run.id) {
      setOpenRun(null)
      setOpenRunResult(null)
      return
    }
    setOpenRun(run.id)
    setOpenRunResult(null)
    setResultLoading(true)
    // Task IDs are encoded in the run name (display_title) which equals
    // the workflow_dispatch input snapshot. Use the first input "task_id"
    // we can extract — fall back to scanning the result directory.
    // Simpler: try to read by pattern from the run.name (which github sets
    // to display_title — the prompt — not the task id). We need to look up
    // the run inputs explicitly via the API.
    try {
      // Task id isn't in the run summary. Instead, fall back: scan
      // .holdenmercer/tasks/ for the newest file with a matching head_sha.
      // For v1 we just try to fetch by guessing the most recent task id
      // from the workflow run timestamp. If that fails, show "still running".
      // -- pragmatic v1: fetch the result file via head_sha-based path lookup is
      //    out of scope; instead we surface the workflow's html_url for now and
      //    list any committed result files via .holdenmercer/tasks via dir listing.
      // Show the run-level metadata until task-id mapping is wired up.
      setOpenRunResult(null)
    } finally {
      setResultLoading(false)
    }
    // Try fetching each task file in .holdenmercer/tasks/ that was created
    // close to this run; v1 is "click out to GitHub" but we'll improve this.
    void run
  }

  return (
    <div className="hm-tasks">
      <header className="hm-tasks-header">
        <div>
          <h2 className="hm-tasks-title">Background tasks</h2>
          <p className="hm-tasks-help">
            Long-running agent work. Tell Claude what to build from the Console
            via <strong>Run in background ↗</strong>; the agent runs inside
            GitHub Actions for up to 6 hours, commits as it goes, and writes a
            summary you can read here once it's done.
          </p>
        </div>
        <div className="hm-tasks-actions">
          {!installed && (
            <button className="hm-btn-primary" onClick={install} disabled={busy !== null}>
              {busy === 'install' ? 'Installing…' : 'Install task workflow'}
            </button>
          )}
          <button className="hm-btn-ghost" onClick={refresh} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      {error && <div className="hm-memory-error">{error}</div>}
      {secretsUrl && (
        <div className="hm-tasks-empty">
          <strong>Last step:</strong> tasks need an Anthropic key in this repo.
          Open <a href={secretsUrl} target="_blank" rel="noreferrer">{secretsUrl}</a>{' '}
          and add a secret named <code>ANTHROPIC_API_KEY</code>. (One-time per repo.)
        </div>
      )}

      {!installed && !secretsUrl && (
        <div className="hm-tasks-empty">
          <p>
            The task workflow isn't in this repo yet. Click <strong>Install task
            workflow</strong> above and we'll commit{' '}
            <code>.github/workflows/holden-mercer-task.yml</code> +{' '}
            <code>.holdenmercer/agent_runner.py</code>. After that you'll need to
            add your Anthropic API key as a repo secret named{' '}
            <code>ANTHROPIC_API_KEY</code>.
          </p>
        </div>
      )}

      {installed && runs.length === 0 && !loading && (
        <div className="hm-tasks-empty">
          <p>
            No tasks yet. Open the Console, type what you want built, and click{' '}
            <strong>Run in background ↗</strong>.
          </p>
        </div>
      )}

      <ul className="hm-gate-list">
        {runs.map((run) => {
          const concl =
            run.status === 'completed'
              ? (run.conclusion ?? 'unknown')
              : (STATUS_LABEL[run.status] ?? run.status)
          const ok   = run.status === 'completed' && run.conclusion === 'success'
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
                    <code>{run.branch}</code> · <code>{run.head_sha?.slice(0, 7)}</code>
                    {run.actor ? ` · ${run.actor}` : ''} · {formatTime(run.created_at)}
                  </span>
                  {run.name && (
                    <span className="hm-gate-row-sub" style={{ marginTop: 2 }}>
                      {run.name}
                    </span>
                  )}
                </span>
              </div>
              <div className="hm-gate-row-actions">
                <a className="hm-btn-ghost" href={run.html_url} target="_blank" rel="noreferrer">
                  Open ↗
                </a>
                <a
                  className="hm-btn-ghost"
                  href={`https://github.com/${repo}/tree/${run.branch}/.holdenmercer/tasks`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Results dir ↗
                </a>
              </div>
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
