/**
 * LinkRepoModal — picks (or unpicks) a GitHub repo for a project.
 *
 * Once linked, the project's Brief and session summaries get committed back
 * to the repo (under .holdenmercer/) on every save. The repo IS the memory.
 *
 * Linking does two things:
 *   1. Updates the project record with { repo, branch }.
 *   2. Pushes the current Brief to the repo as .holdenmercer/brief.md so the
 *      repo immediately reflects what's in localStorage.
 */

import { useEffect, useState } from 'react'
import { useProjects } from '../stores/projects'
import { useSettings } from '../stores/settings'
import { listRepos, writeMeta, type RepoSummary } from '../lib/repo'

interface Props {
  projectId: string
  open:      boolean
  onClose:   () => void
}

export function LinkRepoModal({ projectId, open, onClose }: Props) {
  const project   = useProjects((s) => s.projects.find((p) => p.id === projectId))
  const update    = useProjects((s) => s.update)
  const githubKey = useSettings((s) => s.githubToken)

  const [search, setSearch]   = useState('')
  const [repos,  setRepos]    = useState<RepoSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error,  setError]    = useState<string | null>(null)
  const [linking, setLinking] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    if (!githubKey) {
      setError('Add a code-host PAT in Settings first.')
      return
    }
    setLoading(true)
    setError(null)
    listRepos()
      .then(setRepos)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [open, githubKey])

  if (!open || !project) return null

  const filtered = repos.filter((r) =>
    !search.trim() || r.name.toLowerCase().includes(search.toLowerCase())
  )

  const link = async (repo: RepoSummary) => {
    setLinking(repo.full_name)
    setError(null)
    try {
      // Push the current Brief to the repo so it has a baseline state.
      if (project.description.trim()) {
        await writeMeta(
          repo.full_name,
          'brief.md',
          briefMarkdown(project.name, project.description),
          'Add Holden Mercer brief',
        )
      }
      update(projectId, { repo: repo.full_name, branch: repo.default_branch })
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLinking(null)
    }
  }

  const unlink = () => {
    update(projectId, { repo: null, branch: null })
    onClose()
  }

  return (
    <div className="hm-modal-backdrop" onClick={onClose}>
      <div className="hm-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="hm-modal-title">
          {project.repo ? `Linked to ${project.repo}` : 'Link a repo'}
        </h2>
        <p className="hm-modal-lede">
          The Brief and session summaries get committed to <code>.holdenmercer/</code>
          in this repo so Claude has persistent memory across sessions. Pick an
          existing repo — or unlink to keep the project local-only.
        </p>

        {project.repo && (
          <div className="hm-link-current">
            <span>
              Currently linked to <code>{project.repo}</code> on{' '}
              <code>{project.branch || 'main'}</code>.
            </span>
            <button className="hm-btn-ghost" onClick={unlink}>Unlink</button>
          </div>
        )}

        <input
          className="hm-input"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search repos…"
          autoFocus
        />

        {error && <div className="hm-link-error">{error}</div>}

        <div className="hm-link-list">
          {loading && <div className="hm-link-empty">Loading…</div>}
          {!loading && filtered.length === 0 && (
            <div className="hm-link-empty">
              {repos.length === 0 ? 'No repos returned. Check your token + org.' : 'No repos match.'}
            </div>
          )}
          {filtered.map((r) => (
            <button
              key={r.full_name}
              className={`hm-link-row${project.repo === r.full_name ? ' is-linked' : ''}`}
              onClick={() => link(r)}
              disabled={linking !== null}
            >
              <div className="hm-link-row-main">
                <span className="hm-link-name">{r.full_name}</span>
                {r.private && <span className="hm-link-tag">private</span>}
                {r.description && (
                  <span className="hm-link-desc">{r.description}</span>
                )}
              </div>
              <span className="hm-link-action">
                {linking === r.full_name ? 'Linking…' : project.repo === r.full_name ? 'Linked' : 'Link →'}
              </span>
            </button>
          ))}
        </div>

        <div className="hm-modal-actions">
          <button type="button" className="hm-btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

function briefMarkdown(name: string, description: string): string {
  return `# ${name}\n\n${description.trim()}\n\n---\n\n_Maintained by Holden Mercer (holdenmercer.com)._\n`
}
