/**
 * Planner — drafting surface for "what we're going to do next."
 *
 * You write a plan (dictated on iPad, typed on desktop), refine it, then
 * hand it to Claude with one click — no copy-paste:
 *
 *   • Send to Console  →  pre-fills the Console composer with the plan's
 *                         body and switches to the Console tab. You hit
 *                         Send (or 🧩 Swarm) yourself.
 *   • Run in background →  dispatches a GitHub Actions task with the plan
 *                         as the prompt. Closes the tab; check Tasks for
 *                         status. Marks the plan as 'shipped'.
 *
 * Plans live in localStorage per project. Multiple plans per project — pick
 * one from the list to edit. Native textarea so OS dictation Just Works.
 */

import { useEffect, useState } from 'react'
import { usePlans, type Plan, type PlanStatus } from '../stores/plans'
import { useChat } from '../stores/chat'
import { useProjects } from '../stores/projects'
import { useSettings } from '../stores/settings'
import { dispatchTask } from '../lib/jobs'

interface Props {
  projectId: string
  /** Switches the parent ProjectShell over to the Console tab. */
  onSwitchToConsole: () => void
}

const STATUS_LABEL: Record<PlanStatus, string> = {
  draft:    'draft',
  ready:    'ready',
  shipped:  'shipped',
  archived: 'archived',
}

export function Planner({ projectId, onSwitchToConsole }: Props) {
  const project          = useProjects((s) => s.projects.find((p) => p.id === projectId))
  const plans            = usePlans((s) => s.list(projectId))
  const activePlanId     = usePlans((s) => s.activeByProject[projectId] ?? null)
  const setActive        = usePlans((s) => s.setActive)
  const create           = usePlans((s) => s.create)
  const update           = usePlans((s) => s.update)
  const remove           = usePlans((s) => s.remove)
  const setPendingInput  = useChat((s) => s.setPendingInput)
  // Select fields, not the whole store, to avoid re-rendering on every
  // unrelated settings change.
  const anthropicKey = useSettings((s) => s.anthropicKey)
  const defaultModel = useSettings((s) => s.defaultModel)
  const settings = { anthropicKey, defaultModel }

  // Auto-pick the first plan or create a starter when the tab opens for a
  // project that has none yet.
  useEffect(() => {
    if (activePlanId) return
    if (plans.length > 0) {
      setActive(projectId, plans[0].id)
    } else {
      create(projectId, {
        title: 'First plan',
        body:  '# What I want to build\n\n- ',
      })
    }
  }, [projectId, plans.length, activePlanId, setActive, create])

  const activePlan = plans.find((p) => p.id === activePlanId) ?? plans[0] ?? null

  if (!project) return null

  return (
    <div className="hm-planner">
      <header className="hm-planner-header">
        <div>
          <h2 className="hm-planner-title">Planner</h2>
          <p className="hm-planner-help">
            Think out loud here, refine the plan, then hand it to Claude. The
            plan becomes the prompt — no copy-paste. Dictate freely; this is
            a plain textarea so iPad / Mac / Win+H all work natively.
          </p>
        </div>
        <button
          className="hm-btn-ghost"
          onClick={() => create(projectId, { title: 'New plan', body: '' })}
        >
          + New plan
        </button>
      </header>

      <div className="hm-planner-body">
        <aside className="hm-planner-list">
          {plans.length === 0 && (
            <div className="hm-planner-empty">No plans yet.</div>
          )}
          {plans.map((p) => (
            <button
              key={p.id}
              className={`hm-planner-row${p.id === activePlan?.id ? ' is-active' : ''}`}
              onClick={() => setActive(projectId, p.id)}
            >
              <div className="hm-planner-row-title">{p.title || 'Untitled'}</div>
              <div className="hm-planner-row-meta">
                <span className={`hm-planner-status hm-planner-status-${p.status}`}>
                  {STATUS_LABEL[p.status]}
                </span>
                <span className="hm-planner-row-updated">
                  {formatRelative(p.updatedAt)}
                </span>
              </div>
            </button>
          ))}
        </aside>

        {activePlan && (
          <Editor
            key={activePlan.id}
            plan={activePlan}
            ready={Boolean(settings.anthropicKey)}
            hasRepo={Boolean(project.repo)}
            onUpdate={(patch) => update(activePlan.id, patch)}
            onDelete={() => {
              if (!confirm(`Delete "${activePlan.title}"?`)) return
              remove(activePlan.id)
            }}
            onSendToConsole={() => {
              setPendingInput(projectId, activePlan.body.trim())
              update(activePlan.id, { status: 'shipped' })
              onSwitchToConsole()
            }}
            onRunInBackground={async () => {
              if (!project.repo) return
              try {
                await dispatchTask({
                  repo:    project.repo,
                  prompt:  activePlan.body.trim(),
                  brief:   project.description,
                  model:   settings.defaultModel,
                  branch:  project.branch ?? undefined,
                })
                update(activePlan.id, { status: 'shipped' })
              } catch (err) {
                alert(`Could not dispatch task: ${(err as Error).message}`)
              }
            }}
          />
        )}
      </div>
    </div>
  )
}

interface EditorProps {
  plan: Plan
  ready: boolean
  hasRepo: boolean
  onUpdate:          (patch: Partial<Pick<Plan, 'title' | 'body' | 'status'>>) => void
  onDelete:          () => void
  onSendToConsole:   () => void
  onRunInBackground: () => void
}

function Editor({
  plan, ready, hasRepo,
  onUpdate, onDelete, onSendToConsole, onRunInBackground,
}: EditorProps) {
  const [title, setTitle] = useState(plan.title)
  const [body,  setBody]  = useState(plan.body)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    setTitle(plan.title); setBody(plan.body); setDirty(false)
  }, [plan.id])

  const save = () => {
    onUpdate({ title: title.trim() || 'Untitled', body })
    setDirty(false)
  }

  return (
    <section className="hm-planner-editor">
      <input
        className="hm-input hm-planner-title-input"
        value={title}
        onChange={(e) => { setTitle(e.target.value); setDirty(true) }}
        onBlur={save}
        placeholder="Plan title"
        spellCheck
        autoCapitalize="words"
      />

      <textarea
        className="hm-textarea hm-planner-textarea"
        value={body}
        onChange={(e) => { setBody(e.target.value); setDirty(true) }}
        onBlur={save}
        rows={20}
        placeholder={
          'What are you building?\n\nGoals:\n- \n\nConstraints:\n- \n\nNon-goals:\n- '
        }
        autoCapitalize="sentences"
        autoCorrect="on"
        spellCheck
      />

      <div className="hm-planner-footer">
        <div className="hm-planner-status-pick">
          <label htmlFor={`status-${plan.id}`}>Status</label>
          <select
            id={`status-${plan.id}`}
            className="hm-input hm-planner-status-select"
            value={plan.status}
            onChange={(e) => onUpdate({ status: e.target.value as PlanStatus })}
          >
            <option value="draft">Draft</option>
            <option value="ready">Ready</option>
            <option value="shipped">Shipped</option>
            <option value="archived">Archived</option>
          </select>
          <span className="hm-planner-dirty">{dirty ? '· unsaved' : '· saved'}</span>
        </div>

        <div className="hm-planner-actions">
          <button className="hm-btn-ghost" onClick={onDelete}>Delete</button>
          <button className="hm-btn-ghost" onClick={save} disabled={!dirty}>Save</button>
          <button
            className="hm-btn-ghost"
            onClick={onSendToConsole}
            disabled={!ready || !body.trim()}
            title="Pre-fill the Console composer with this plan and switch tabs"
          >
            Send to Console →
          </button>
          {hasRepo && (
            <button
              className="hm-btn-primary"
              onClick={onRunInBackground}
              disabled={!ready || !body.trim()}
              title="Dispatch this plan as a background task — runs in GitHub Actions for up to 6h"
            >
              Run in background ↗
            </button>
          )}
        </div>
      </div>
    </section>
  )
}

function formatRelative(ts: number): string {
  const diffMs = Date.now() - ts
  const m = Math.floor(diffMs / 60_000)
  if (m < 1)   return 'just now'
  if (m < 60)  return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24)  return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30)  return `${d}d ago`
  return new Date(ts).toLocaleDateString()
}
