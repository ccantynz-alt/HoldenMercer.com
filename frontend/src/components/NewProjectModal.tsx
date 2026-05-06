/**
 * NewProjectModal — two ways to start a project:
 *
 *   1. Blank — name + brief, no repo (link later from the project header)
 *   2. From an existing repo — pick from the user's GitHub repos and
 *      pre-fill the project linked to that repo + its description
 *
 * Both create the project, set it as active, and close.
 */

import { useEffect, useState } from 'react'
import { useProjects } from '../stores/projects'
import { useSettings } from '../stores/settings'
import { listRepos, type RepoSummary } from '../lib/repo'

interface Props {
  open:    boolean
  onClose: () => void
}

type Mode = 'blank' | 'repo'

export function NewProjectModal({ open, onClose }: Props) {
  const create = useProjects((s) => s.create)
  const githubKey = useSettings((s) => s.githubToken)

  const [mode, setMode]               = useState<Mode>('blank')
  const [name, setName]               = useState('')
  const [description, setDescription] = useState('')
  const [repos, setRepos]             = useState<RepoSummary[]>([])
  const [reposLoading, setReposLoading] = useState(false)
  const [search, setSearch]           = useState('')
  const [error, setError]             = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setMode('blank')
    setName('')
    setDescription('')
    setRepos([])
    setSearch('')
    setError(null)
  }, [open])

  // Lazy-load repos when the user switches to "From existing repo".
  useEffect(() => {
    if (mode !== 'repo' || !open) return
    if (!githubKey) {
      setError('Add a code-host PAT in Settings first.')
      return
    }
    if (repos.length > 0) return
    setReposLoading(true)
    setError(null)
    listRepos()
      .then(setRepos)
      .catch((err) => setError(err.message))
      .finally(() => setReposLoading(false))
  }, [mode, open, githubKey, repos.length])

  if (!open) return null

  const submitBlank = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    create({ name, description })
    onClose()
  }

  const importRepo = (repo: RepoSummary) => {
    create({
      name:        repo.name,
      description: repo.description,
      repo:        repo.full_name,
      branch:      repo.default_branch,
    })
    onClose()
  }

  const filteredRepos = repos.filter((r) =>
    !search.trim() || r.name.toLowerCase().includes(search.toLowerCase()) ||
    (r.description ?? '').toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="hm-modal-backdrop" onClick={onClose}>
      <div className="hm-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="hm-modal-title">New project</h2>

        <div className="hm-tabs hm-tabs-modal">
          <button
            className={`hm-tab${mode === 'blank' ? ' is-active' : ''}`}
            onClick={() => setMode('blank')}
          >
            Blank
          </button>
          <button
            className={`hm-tab${mode === 'repo' ? ' is-active' : ''}`}
            onClick={() => setMode('repo')}
          >
            From existing repo
          </button>
        </div>

        {mode === 'blank' ? (
          <form onSubmit={submitBlank} className="hm-form-stack">
            <p className="hm-modal-lede">
              A project is one thing you're building. Give it a name and a one-line
              brief — Claude reads the brief on every session.
            </p>

            <label className="hm-field">
              <span className="hm-field-label">Name</span>
              <input
                className="hm-input"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Glassblade"
                autoFocus
                autoCapitalize="words"
                spellCheck
              />
            </label>

            <label className="hm-field">
              <span className="hm-field-label">Brief</span>
              <textarea
                className="hm-textarea"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="A landing page for my glassblowing studio. Editorial, dark theme, gallery + booking form."
                rows={4}
                autoCapitalize="sentences"
                autoCorrect="on"
                spellCheck
              />
            </label>

            <div className="hm-modal-actions">
              <button type="button" className="hm-btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="hm-btn-primary" disabled={!name.trim()}>
                Create project
              </button>
            </div>
          </form>
        ) : (
          <div className="hm-form-stack">
            <p className="hm-modal-lede">
              Pick a repo and we'll create a project linked to it. Brief defaults
              to the repo description; you can edit it later.
            </p>

            <input
              className="hm-input"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search your repos…"
              autoFocus
            />

            {error && <div className="hm-link-error">{error}</div>}

            <div className="hm-link-list">
              {reposLoading && <div className="hm-link-empty">Loading…</div>}
              {!reposLoading && filteredRepos.length === 0 && (
                <div className="hm-link-empty">
                  {repos.length === 0 ? 'No repos returned.' : 'No matches.'}
                </div>
              )}
              {filteredRepos.map((r) => (
                <button
                  key={r.full_name}
                  className="hm-link-row"
                  onClick={() => importRepo(r)}
                >
                  <div className="hm-link-row-main">
                    <span className="hm-link-name">{r.full_name}</span>
                    {r.private && <span className="hm-link-tag">private</span>}
                    {r.description && (
                      <span className="hm-link-desc">{r.description}</span>
                    )}
                  </div>
                  <span className="hm-link-action">Import →</span>
                </button>
              ))}
            </div>

            <div className="hm-modal-actions">
              <button type="button" className="hm-btn-ghost" onClick={onClose}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
