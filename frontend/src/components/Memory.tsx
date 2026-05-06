/**
 * Memory tab — the project's persistent memory, served straight from the
 * linked repo's .holdenmercer/sessions/ directory.
 *
 * Every Console turn writes a markdown session summary into the repo, so
 * memory survives device changes and tab closes. This tab lists those
 * sessions newest-first and lets you click in to view one.
 *
 * If the project isn't linked to a repo, the tab explains how to enable it.
 */

import { useEffect, useState } from 'react'
import { useProjects } from '../stores/projects'
import { listDir, readFile, type DirItem } from '../lib/repo'

interface Props {
  projectId: string
}

interface SessionFile extends DirItem {
  /** Parsed timestamp from the filename, ms since epoch — for sorting / display. */
  timestamp: number
}

export function Memory({ projectId }: Props) {
  const project = useProjects((s) => s.projects.find((p) => p.id === projectId))
  const [items,   setItems]   = useState<SessionFile[]>([])
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [active,  setActive]  = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [contentLoading, setContentLoading] = useState(false)

  const repo   = project?.repo
  const branch = project?.branch || undefined

  const [refreshTick, setRefreshTick] = useState(0)
  const load = () => setRefreshTick((n) => n + 1)

  useEffect(() => {
    if (!repo) return
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const dir = await listDir(repo, '.holdenmercer/sessions', branch)
        if (cancelled) return
        const files = dir
          .filter((it) => it.type === 'file' && it.name.endsWith('.md'))
          .map((it) => ({ ...it, timestamp: parseTimestamp(it.name) }))
          .sort((a, b) => b.timestamp - a.timestamp)
        setItems(files)
      } catch (err) {
        if (!cancelled) setError((err as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [repo, branch, refreshTick])

  const open = async (item: SessionFile) => {
    if (!repo) return
    setActive(item.path)
    setContentLoading(true)
    setContent(null)
    try {
      const text = await readFile(repo, item.path, branch)
      setContent(text)
    } catch (err) {
      setContent(`[error: ${(err as Error).message}]`)
    } finally {
      setContentLoading(false)
    }
  }

  if (!project) return null

  if (!project.repo) {
    return (
      <div className="hm-placeholder">
        <h2 className="hm-placeholder-title">No repo linked.</h2>
        <p className="hm-placeholder-body">
          Memory lives in <code>.holdenmercer/sessions/</code> in this project's
          repo. Click <strong>+ Link a repo</strong> above the tabs to enable
          persistent memory — every Console turn gets committed back so future
          sessions can read it.
        </p>
      </div>
    )
  }

  return (
    <div className="hm-memory">
      <header className="hm-memory-header">
        <div>
          <h2 className="hm-memory-title">Memory</h2>
          <p className="hm-memory-help">
            Session summaries from <code>{project.repo}/.holdenmercer/sessions/</code>.
            Each Console turn writes one entry. Click any session to read what happened.
          </p>
        </div>
        <button className="hm-btn-ghost" onClick={load} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      {error && <div className="hm-memory-error">{error}</div>}

      <div className="hm-memory-body">
        <ul className="hm-memory-list">
          {!loading && items.length === 0 && !error && (
            <li className="hm-memory-empty">
              No sessions yet. Open the Console and chat with Claude — every turn lands here.
            </li>
          )}
          {items.map((it) => (
            <li key={it.path}>
              <button
                className={`hm-memory-row${active === it.path ? ' is-active' : ''}`}
                onClick={() => open(it)}
              >
                <span className="hm-memory-row-time">{formatTimestamp(it.timestamp)}</span>
                <span className="hm-memory-row-name">{it.name.replace(/\.md$/, '')}</span>
              </button>
            </li>
          ))}
        </ul>

        <div className="hm-memory-viewer">
          {!active && <div className="hm-memory-empty">Pick a session to read it.</div>}
          {active && contentLoading && <div className="hm-memory-empty">Loading…</div>}
          {active && !contentLoading && content !== null && (
            <pre className="hm-memory-content">{content}</pre>
          )}
        </div>
      </div>
    </div>
  )
}

function parseTimestamp(name: string): number {
  // Filename format: YYYY-MM-DD-HHMMSS.md (UTC)
  const m = name.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})\.md$/)
  if (!m) return 0
  const [, y, mo, d, h, mi, s] = m
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)
}

function formatTimestamp(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}
