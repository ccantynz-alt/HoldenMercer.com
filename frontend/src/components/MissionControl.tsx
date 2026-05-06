/**
 * MissionControl — the new home view.
 *
 * One screen, one obvious action: tell Claude what to do.
 * - Big LiquidOrb hero that reflects system busyness
 * - Single command textarea + project picker + dispatch
 * - Live agent activity feed (recent task runs across linked projects)
 * - Quick actions for the things users actually do (new project, settings)
 *
 * Sits ABOVE the existing AdminHome / projects grid in SystemHome. Old
 * AdminHome stays accessible for the kitchen-sink view.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useProjects } from '../stores/projects'
import { dispatchTask, listTaskRuns, type TaskRun } from '../lib/jobs'
import { LiquidOrb, type OrbStatus } from './LiquidOrb'

interface Props {
  onNewProject:   () => void
  onOpenProject:  (id: string) => void
  onOpenSettings: () => void
}

interface AggregatedRun extends TaskRun {
  projectId:   string
  projectName: string
  repo:        string
}

export function MissionControl({ onNewProject, onOpenProject, onOpenSettings }: Props) {
  const projects = useProjects((s) => s.projects)
  const linkedProjects = useMemo(
    () => projects.filter((p) => !!p.repo),
    [projects],
  )

  const [target, setTarget]       = useState<string>(() => linkedProjects[0]?.id ?? '')
  const [prompt, setPrompt]       = useState('')
  const [busy, setBusy]           = useState(false)
  const [error, setError]         = useState<string | null>(null)
  const [success, setSuccess]     = useState<string | null>(null)
  const [runs, setRuns]           = useState<AggregatedRun[]>([])
  const [feedError, setFeedError] = useState<string | null>(null)

  // Keep target in sync when linkedProjects changes (first-load race).
  useEffect(() => {
    if (!target && linkedProjects[0]) setTarget(linkedProjects[0].id)
  }, [linkedProjects, target])

  // Aggregate recent task runs from each linked project. We rely on a
  // stable list of "owner/repo" strings rather than the project objects so
  // the effect doesn't fire on unrelated project metadata edits.
  const repoKey = useMemo(
    () => linkedProjects.map((p) => `${p.id}|${p.repo}|${p.name}`).join(','),
    [linkedProjects],
  )

  const refreshFeed = useCallback(async () => {
    if (linkedProjects.length === 0) {
      setRuns([])
      setFeedError(null)
      return
    }
    try {
      const results = await Promise.all(
        linkedProjects.map(async (p) => {
          try {
            const data = await listTaskRuns(p.repo!, p.branch ?? undefined)
            return data.runs.slice(0, 5).map<AggregatedRun>((r) => ({
              ...r,
              projectId:   p.id,
              projectName: p.name,
              repo:        p.repo!,
            }))
          } catch {
            return [] as AggregatedRun[]
          }
        }),
      )
      const merged = results.flat()
      merged.sort((a, b) => b.created_at.localeCompare(a.created_at))
      setRuns(merged.slice(0, 8))
      setFeedError(null)
    } catch (err) {
      setFeedError((err as Error).message)
    }
  }, [linkedProjects])

  useEffect(() => {
    refreshFeed()
    const id = setInterval(refreshFeed, 15_000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoKey])

  const activeRunCount = runs.filter((r) => r.status !== 'completed').length
  const orbStatus: OrbStatus = busy
    ? 'busy'
    : activeRunCount > 0
      ? 'active'
      : 'idle'

  const targetProject = linkedProjects.find((p) => p.id === target)

  const dispatch = async () => {
    if (!targetProject?.repo) {
      setError('Pick a project with a linked repo first.')
      return
    }
    if (!prompt.trim()) {
      setError('Tell Claude what you want.')
      return
    }
    setBusy(true)
    setError(null)
    setSuccess(null)
    try {
      const r = await dispatchTask({
        repo:      targetProject.repo,
        prompt:    prompt.trim(),
        brief:     `Mission Control dispatch from the home screen.`,
        branch:    targetProject.branch ?? undefined,
        max_iters: 40,
      })
      setSuccess(`Dispatched as ${r.task_id}. Refreshing the feed…`)
      setPrompt('')
      // Quick refresh; backend may take a beat to register the run.
      setTimeout(refreshFeed, 1500)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="hm-mission">
      <section className="hm-mission-hero">
        <div className="hm-mission-orb" aria-hidden>
          <LiquidOrb status={orbStatus} size={200} />
        </div>
        <div className="hm-mission-headline">
          <h1 className="hm-mission-title">Mission Control</h1>
          <p className="hm-mission-tagline">
            One line, one click. Tell Claude what to build, fix, or investigate.
          </p>
          <div className="hm-mission-status">
            <span
              className={`hm-mission-status-dot${busy || activeRunCount > 0 ? ' is-on' : ''}`}
              aria-hidden
            />
            {busy
              ? 'Dispatching…'
              : activeRunCount > 0
                ? `${activeRunCount} agent${activeRunCount === 1 ? '' : 's'} working`
                : 'Idle — ready when you are'}
          </div>
        </div>
      </section>

      <section className={`hm-ai-card${busy ? ' is-running' : ''} hm-mission-command`}>
        <label className="hm-mission-label" htmlFor="hm-mission-input">
          What should Claude do?
        </label>
        <textarea
          id="hm-mission-input"
          className="hm-mission-textarea"
          rows={4}
          placeholder="e.g. Audit /api/jobs for silent 404s and fix them. Open a PR; the gate must be green before merge."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              dispatch()
            }
          }}
          disabled={busy}
        />
        <div className="hm-mission-row">
          <div className="hm-mission-target">
            <label htmlFor="hm-mission-project" className="hm-mission-target-label">
              Project
            </label>
            <select
              id="hm-mission-project"
              className="hm-ai-select"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              disabled={busy || linkedProjects.length === 0}
            >
              {linkedProjects.length === 0 && (
                <option value="">No linked repos — create one first</option>
              )}
              {linkedProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.repo}
                </option>
              ))}
            </select>
          </div>
          <div className="hm-mission-row-actions">
            <span className="hm-mission-hint">⌘ + Enter to dispatch</span>
            <button
              className="hm-btn-primary hm-btn-glow"
              onClick={dispatch}
              disabled={busy || linkedProjects.length === 0 || !prompt.trim()}
            >
              {busy ? 'Dispatching…' : 'Dispatch ↗'}
            </button>
          </div>
        </div>
        {error   && <div className="hm-ai-error">{error}</div>}
        {success && <div className="hm-ai-banner">✨ {success}</div>}
      </section>

      <section className="hm-mission-feed">
        <header className="hm-mission-feed-header">
          <h2 className="hm-mission-section-title">Live agent activity</h2>
          <button className="hm-btn-ghost" onClick={refreshFeed} title="Refresh">
            ↻
          </button>
        </header>
        {feedError && <div className="hm-ai-error">{feedError}</div>}
        {runs.length === 0 && !feedError && (
          <div className="hm-mission-feed-empty">
            No recent runs.{' '}
            {linkedProjects.length === 0
              ? 'Link a repo to a project and dispatch your first task.'
              : 'Dispatch a task above and it’ll show up here.'}
          </div>
        )}
        <ul className="hm-mission-feed-list">
          {runs.map((r) => {
            const ok   = r.status === 'completed' && r.conclusion === 'success'
            const fail = r.status === 'completed' && r.conclusion && r.conclusion !== 'success' && r.conclusion !== 'skipped'
            const live = r.status !== 'completed'
            return (
              <li
                key={`${r.projectId}-${r.id}`}
                className={`hm-mission-feed-row${ok ? ' is-ok' : ''}${fail ? ' is-fail' : ''}${live ? ' is-live' : ''}`}
              >
                <span className="hm-mission-feed-icon" aria-hidden>
                  {live ? '◌' : ok ? '✓' : fail ? '✗' : '·'}
                </span>
                <button
                  className="hm-mission-feed-project"
                  onClick={() => onOpenProject(r.projectId)}
                  title="Open project"
                >
                  {r.projectName}
                </button>
                <span className="hm-mission-feed-meta">
                  <code>{r.branch}</code> · {r.head_sha.slice(0, 7)} · {formatTime(r.created_at)}
                </span>
                <a
                  className="hm-mission-feed-link"
                  href={r.html_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  open ↗
                </a>
              </li>
            )
          })}
        </ul>
      </section>

      <section className="hm-mission-quick">
        <button className="hm-mission-quick-btn" onClick={onNewProject}>
          <span className="hm-mission-quick-icon">＋</span>
          <div>
            <div className="hm-mission-quick-title">New project</div>
            <div className="hm-mission-quick-sub">Spin up a fresh build</div>
          </div>
        </button>
        <button className="hm-mission-quick-btn" onClick={onOpenSettings}>
          <span className="hm-mission-quick-icon">⚙</span>
          <div>
            <div className="hm-mission-quick-title">Settings</div>
            <div className="hm-mission-quick-sub">Keys, model, gatetest.ai</div>
          </div>
        </button>
      </section>
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
