/**
 * Preview tab — live iframe of the project's deployed site PLUS Edit mode
 * (Layer 1 of the visual builder roadmap).
 *
 * Two modes:
 *
 *  • PREVIEW (default) — embeds the project's live URL in an iframe.
 *    Auto-reloads after every Console turn so you watch the site update
 *    as Claude commits.
 *
 *  • EDIT — split view: iframe on the left, find/replace edit panel on
 *    the right. Paste a piece of text from the live site, type the
 *    replacement, click Save edit. HM dispatches a tightly-scoped
 *    background task ("find this exact text in the repo, replace with
 *    that, open a PR") and shows live progress on the panel. When the
 *    PR merges + Vercel redeploys, the iframe auto-refreshes and you
 *    see the change.
 *
 *    No prompts to write. No filesystem hunting. Edit copy from the
 *    same screen you're viewing it on.
 */

import { useEffect, useMemo, useState } from 'react'
import { useChat } from '../stores/chat'
import { useProjects } from '../stores/projects'
import { dispatchTask, listTaskRuns, fetchRunLogs, type TaskRun } from '../lib/jobs'
import { useSettings } from '../stores/settings'
import { toast } from '../stores/toast'
import { checkDispatch, effectiveDispatchModel } from '../lib/dispatchGuard'

interface Props {
  projectId: string
}

export function Preview({ projectId }: Props) {
  const project = useProjects((s) => s.projects.find((p) => p.id === projectId))
  const update  = useProjects((s) => s.update)

  const [editing, setEditing] = useState(false)
  const [draft,   setDraft]   = useState(project?.previewUrl ?? '')
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [manualNonce, setManualNonce] = useState(0)

  // Edit mode (Layer 1 visual builder)
  const [editMode, setEditMode]   = useState(false)
  const [findText, setFindText]   = useState('')
  const [replaceText, setReplaceText] = useState('')
  const [activeEdit, setActiveEdit] = useState<{
    taskId: string
    runId:  number | null
    status: 'queued' | 'in_progress' | 'completed' | 'unknown'
    startedAt: number
    logs: string
    find: string
    replace: string
  } | null>(null)

  // Watch the project's chat thread — bump the nonce when an assistant turn
  // finishes streaming so the iframe reloads.
  const lastTurnId = useChat((s) => {
    const t = s.threads[projectId] ?? []
    for (let i = t.length - 1; i >= 0; i--) {
      const m = t[i]
      if (m.role === 'assistant' && !m.streaming) return m.id
    }
    return ''
  })

  useEffect(() => {
    setDraft(project?.previewUrl ?? '')
    setEditing(false)
  }, [projectId, project?.previewUrl])

  if (!project) return null

  const url = project.previewUrl || ''
  const validUrl = isLikelyUrl(url)

  // The iframe's `src` is the URL; the `key` forces React to remount it
  // (= hard reload) whenever lastTurnId or manualNonce changes.
  const reloadKey = useMemo(() => {
    return `${manualNonce}|${autoRefresh ? lastTurnId : '_'}`
  }, [manualNonce, autoRefresh, lastTurnId])

  const save = () => {
    update(projectId, { previewUrl: draft.trim() || null })
    setEditing(false)
  }

  // Live polling for the active edit task — same pattern as gatetest.ai's
  // LiveFixProgress. Updates status + logs every 5s; completion triggers
  // an iframe refresh after a short delay so the user sees the change.
  useEffect(() => {
    if (!activeEdit || activeEdit.status === 'completed') return
    if (!project?.repo) return
    let cancelled = false
    const tick = async () => {
      try {
        const runs = (await listTaskRuns(project.repo!, undefined)).runs as TaskRun[]
        const match = activeEdit.runId
          ? runs.find((r) => r.id === activeEdit.runId)
          : runs.find((r) => r.branch && r.branch.startsWith('claude/edit-')) || runs[0]
        if (!match) return
        let logs = activeEdit.logs
        try {
          const lr = await fetchRunLogs(match.id)
          logs = lr.logs || logs
        } catch { /* swallow */ }
        if (cancelled) return
        const status: 'queued' | 'in_progress' | 'completed' | 'unknown' =
          match.status === 'queued' ? 'queued'
          : match.status === 'in_progress' ? 'in_progress'
          : match.status === 'completed' ? 'completed'
          : 'unknown'
        setActiveEdit((prev) => prev ? { ...prev, runId: match.id, status, logs } : prev)
        if (status === 'completed') {
          setTimeout(() => { if (!cancelled) setManualNonce((n) => n + 1) }, 4000)
        }
      } catch { /* swallow */ }
    }
    tick()
    const id = setInterval(tick, 5000)
    return () => { cancelled = true; clearInterval(id) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEdit?.taskId, project?.repo])

  const dispatchEdit = async () => {
    if (!project?.repo) {
      toast('error', 'No repo linked', 'Link a repo to this project first.')
      return
    }
    if (!findText.trim()) {
      toast('error', 'Find text is empty', 'Paste the text you want to change.')
      return
    }
    if (findText.trim() === replaceText.trim()) {
      toast('error', 'Find and replace are identical', 'Change the replacement text.')
      return
    }
    const plan = { model: '', maxIters: 12, forceHaiku: true }
    const blocked = checkDispatch(plan)
    if (blocked) {
      toast('error', 'Edit dispatch blocked', blocked)
      return
    }
    const globalPrefs = useSettings.getState().globalPrefs
    const briefPrefix = globalPrefs.trim()
      ? `User's global preferences (apply to ALL projects):\n${globalPrefs.trim()}\n\n---\n\n`
      : ''
    try {
      const dispatched = await dispatchTask({
        repo:      project.repo,
        prompt:    visualEditPrompt(project.repo, findText.trim(), replaceText.trim()),
        brief:     briefPrefix + `Visual editor — copy edit dispatched from Preview tab.`,
        model:     effectiveDispatchModel(plan),
        max_iters: plan.maxIters,
      })
      setActiveEdit({
        taskId:    dispatched.task_id,
        runId:     null,
        status:    'queued',
        startedAt: Date.now(),
        logs:      '',
        find:      findText.trim(),
        replace:   replaceText.trim(),
      })
      toast('success', 'Edit dispatched',
        `Watch progress on the right. Iframe auto-refreshes when the PR merges.`)
      setFindText('')
      setReplaceText('')
    } catch (err) {
      toast('error', 'Edit dispatch failed', (err as Error).message)
    }
  }

  return (
    <div className="hm-preview">
      <header className="hm-preview-header">
        <div className="hm-preview-meta">
          <h2 className="hm-preview-title">Preview</h2>
          {validUrl && !editing ? (
            <a href={url} target="_blank" rel="noreferrer" className="hm-preview-url">
              {url} ↗
            </a>
          ) : !editing ? (
            <span className="hm-preview-url hm-preview-url-empty">No preview URL set</span>
          ) : null}
        </div>
        <div className="hm-preview-actions">
          {!editing && (
            <>
              <button
                className={editMode ? 'hm-btn-primary' : 'hm-btn-ghost'}
                onClick={() => setEditMode((v) => !v)}
                disabled={!validUrl || !project.repo}
                title={
                  !project.repo ? 'Link a repo to this project first.'
                  : editMode ? 'Exit edit mode' : 'Edit copy on the live site without writing prompts'
                }
              >
                {editMode ? '✓ Editing' : '✎ Edit'}
              </button>
              <label className="hm-preview-toggle" title="Reload the iframe after every Console turn">
                <input
                  type="checkbox"
                  checked={autoRefresh}
                  onChange={(e) => setAutoRefresh(e.target.checked)}
                />
                Auto-refresh
              </label>
              <button
                className="hm-btn-ghost"
                onClick={() => setManualNonce((n) => n + 1)}
                disabled={!validUrl}
              >
                Refresh
              </button>
              <button className="hm-btn-ghost" onClick={() => setEditing(true)}>
                {validUrl ? 'Change URL' : 'Set URL'}
              </button>
            </>
          )}
          {editing && (
            <>
              <input
                className="hm-input hm-preview-input"
                type="url"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="https://your-project.vercel.app"
                autoFocus
                spellCheck={false}
              />
              <button className="hm-btn-primary" onClick={save}>Save</button>
              <button className="hm-btn-ghost" onClick={() => { setDraft(project.previewUrl ?? ''); setEditing(false) }}>
                Cancel
              </button>
            </>
          )}
        </div>
      </header>

      {!validUrl && !editing ? (
        <div className="hm-placeholder">
          <h2 className="hm-placeholder-title">Set a preview URL</h2>
          <p className="hm-placeholder-body">
            Point this tab at your deployed site — a CronTech Sites URL, a
            preview from any host, or a local dev server. The iframe reloads
            automatically after every Console turn so you watch the site change
            as Claude commits.
          </p>
          <p className="hm-placeholder-body" style={{ marginTop: 8 }}>
            <button className="hm-btn-primary" onClick={() => setEditing(true)}>
              Set URL
            </button>
          </p>
        </div>
      ) : validUrl ? (
        <div
          style={{
            display: editMode ? 'grid' : 'block',
            gridTemplateColumns: editMode ? 'minmax(0, 1fr) 380px' : undefined,
            gap: editMode ? 12 : 0,
            height: 'calc(100vh - 180px)',
          }}
        >
          <iframe
            key={reloadKey}
            src={url}
            className="hm-preview-iframe"
            title={`Preview of ${project.name}`}
            sandbox="allow-scripts allow-forms allow-popups allow-same-origin allow-modals"
            referrerPolicy="no-referrer"
            style={{ width: '100%', height: '100%' }}
          />
          {editMode && (
            <EditPanel
              find={findText}
              setFind={setFindText}
              replace={replaceText}
              setReplace={setReplaceText}
              onDispatch={dispatchEdit}
              activeEdit={activeEdit}
              onDismissEdit={() => setActiveEdit(null)}
            />
          )}
        </div>
      ) : null}
    </div>
  )
}

// ── EditPanel — side panel for the Layer 1 visual builder ───────────────────

function EditPanel({ find, setFind, replace, setReplace, onDispatch, activeEdit, onDismissEdit }: {
  find: string
  setFind: (s: string) => void
  replace: string
  setReplace: (s: string) => void
  onDispatch: () => void
  activeEdit: {
    taskId: string
    runId:  number | null
    status: 'queued' | 'in_progress' | 'completed' | 'unknown'
    startedAt: number
    logs: string
    find: string
    replace: string
  } | null
  onDismissEdit: () => void
}) {
  const elapsedSec = activeEdit ? Math.floor((Date.now() - activeEdit.startedAt) / 1000) : 0
  const elapsed = elapsedSec < 60 ? `${elapsedSec}s` : `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`
  return (
    <aside
      style={{
        background: 'var(--bg-elev, rgba(255,255,255,0.02))',
        border: '1px solid var(--border, #2a2a2a)',
        borderRadius: 8,
        padding: 12,
        display: 'flex', flexDirection: 'column', gap: 12,
        overflow: 'auto',
      }}
    >
      <header>
        <h3 style={{ margin: 0, fontSize: 15 }}>✎ Edit copy</h3>
        <p style={{ margin: '4px 0 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
          Paste a piece of text from the page on the left, type the replacement,
          click Save. HM finds it in the repo, replaces it, opens a PR, and the
          iframe auto-refreshes when it merges.
        </p>
      </header>

      <label style={{ display: 'block', fontSize: 12 }}>
        <span style={{ display: 'block', marginBottom: 4, fontWeight: 600 }}>Find this text on the page</span>
        <textarea
          value={find}
          onChange={(e) => setFind(e.target.value)}
          placeholder="e.g. let's play catch up where we up to"
          rows={3}
          spellCheck
          style={{
            width: '100%', padding: 8, borderRadius: 6, fontSize: 13,
            background: 'var(--bg, #0a0a0b)', color: 'var(--text)',
            border: '1px solid var(--border, #2a2a2a)', resize: 'vertical',
          }}
        />
      </label>

      <label style={{ display: 'block', fontSize: 12 }}>
        <span style={{ display: 'block', marginBottom: 4, fontWeight: 600 }}>Replace with</span>
        <textarea
          value={replace}
          onChange={(e) => setReplace(e.target.value)}
          placeholder="The new text you want on the site"
          rows={3}
          spellCheck
          autoCapitalize="sentences"
          style={{
            width: '100%', padding: 8, borderRadius: 6, fontSize: 13,
            background: 'var(--bg, #0a0a0b)', color: 'var(--text)',
            border: '1px solid var(--border, #2a2a2a)', resize: 'vertical',
          }}
        />
      </label>

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          className="hm-btn-primary"
          onClick={onDispatch}
          disabled={!find.trim() || !replace.trim() || !!activeEdit}
          style={{ flex: 1 }}
        >
          {activeEdit ? 'Edit in flight…' : 'Save edit →'}
        </button>
      </div>

      {activeEdit && (
        <section
          style={{
            marginTop: 4, padding: 10,
            background: activeEdit.status === 'completed' ? 'rgba(34,197,94,0.10)' : 'rgba(234,179,8,0.10)',
            border: `1px solid ${activeEdit.status === 'completed' ? 'rgba(34,197,94,0.4)' : 'rgba(234,179,8,0.4)'}`,
            borderRadius: 6, fontSize: 12,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <strong>
              {activeEdit.status === 'completed' ? '✅ Edit done — refreshing iframe…' : `◌ ${activeEdit.status}`}
            </strong>
            <button
              onClick={onDismissEdit}
              style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                color: 'var(--text-muted)', fontSize: 16, lineHeight: 1, padding: 0,
              }}
              title="Dismiss (task continues in background)"
            >×</button>
          </div>
          <div style={{ color: 'var(--text-muted)', marginTop: 4 }}>{elapsed} · auto-refreshes every 5s</div>
          <div style={{ marginTop: 6, fontSize: 11 }}>
            <strong>Find:</strong> <code style={{ wordBreak: 'break-word' }}>{activeEdit.find.slice(0, 80)}{activeEdit.find.length > 80 ? '…' : ''}</code>
            <br />
            <strong>Replace:</strong> <code style={{ wordBreak: 'break-word' }}>{activeEdit.replace.slice(0, 80)}{activeEdit.replace.length > 80 ? '…' : ''}</code>
          </div>
          {activeEdit.logs && (
            <details style={{ marginTop: 6 }}>
              <summary style={{ cursor: 'pointer', color: 'var(--text-muted)' }}>
                Live agent logs ({activeEdit.logs.length.toLocaleString()} chars)
              </summary>
              <pre style={{
                margin: '6px 0 0 0', padding: 8,
                background: 'var(--bg, #0a0a0b)', color: 'var(--text)',
                fontSize: 10, lineHeight: 1.4, maxHeight: 200, overflow: 'auto',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                borderRadius: 4,
              }}>
                {(() => {
                  const lines = activeEdit.logs.split('\n')
                  return lines.length > 40 ? ['[…trimmed…]', ...lines.slice(-40)].join('\n') : activeEdit.logs
                })()}
              </pre>
            </details>
          )}
        </section>
      )}
    </aside>
  )
}

function visualEditPrompt(repo: string, find: string, replace: string): string {
  return `Visual editor — copy edit dispatched from Preview tab on ${repo}.

Find this exact text in the repo:
\`\`\`
${find}
\`\`\`

Replace with:
\`\`\`
${replace}
\`\`\`

DOCTRINE (binding, important):
  • Branch + PR + gate-protected merge — never commit to main directly.
  • Read flywheel context first via check_recent_activity.
  • Use search_repo_code to locate the EXACT text. There may be multiple
    occurrences — use surrounding context (component name, neighboring
    text) to pick the right one. If you genuinely can't disambiguate,
    surface the candidates in the PR body and pick the most likely one
    based on user-facing files (frontend/src/, app/, pages/, etc).
  • Branch name: claude/edit-<short-hash> where short-hash is the first
    8 chars of the find text's slug.
  • ONE commit, one file change (or two if the same text appears in a
    canonical+localised pair). Don't drift; this is a copy edit, not
    a refactor.
  • PR title: "Edit: <first 60 chars of replacement>"
  • PR body: show the find→replace diff + the file path you changed.
  • DO NOT call merge_pull_request — the user reviews + merges manually.
    The user is watching the iframe; they'll see the change after the
    PR merges and Vercel redeploys.
  • If the find text doesn't exist in the repo, report_result with
    success=false and a clear message ("Could not find the text on
    these searches: …"). Do NOT guess at a near-match without asking.

When done: report_result with one paragraph summary including:
  • The file you edited
  • The PR URL
  • Whether you found the text exactly or had to disambiguate`
}

function isLikelyUrl(s: string): boolean {
  if (!s) return false
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}
