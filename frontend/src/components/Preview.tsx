/**
 * Preview tab — live iframe of the project's deployed site.
 *
 * Set a preview URL once (per project, persisted to localStorage) and the
 * tab embeds it in an iframe. The iframe auto-reloads after every Console
 * turn so you watch the site update as Claude commits.
 *
 * Common URLs to point this at:
 *   • Vercel preview / production:  https://your-project.vercel.app
 *   • Cloudflare Pages:             https://your-project.pages.dev
 *   • A local dev server:           http://localhost:5173
 *   • Any staging URL
 */

import { useEffect, useMemo, useState } from 'react'
import { useChat } from '../stores/chat'
import { useProjects } from '../stores/projects'

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
            Point this tab at your deployed site (Vercel preview, production URL,
            local dev server, anything that responds in a browser). The iframe
            reloads automatically after every Console turn so you watch the
            site change as Claude commits.
          </p>
          <p className="hm-placeholder-body" style={{ marginTop: 8 }}>
            <button className="hm-btn-primary" onClick={() => setEditing(true)}>
              Set URL
            </button>
          </p>
        </div>
      ) : validUrl ? (
        <iframe
          key={reloadKey}
          src={url}
          className="hm-preview-iframe"
          title={`Preview of ${project.name}`}
          // Sandbox kept permissive so most apps work; tighten if needed.
          sandbox="allow-scripts allow-forms allow-popups allow-same-origin allow-modals"
          referrerPolicy="no-referrer"
        />
      ) : null}
    </div>
  )
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
