/**
 * Discover — the public showcase of Holden Mercer projects.
 *
 * Reads the curated registry shipped at /public-registry.json and renders
 * a grid of project cards. Click any card → the public project page.
 *
 * To submit a new project to the registry, the user clicks "Submit yours"
 * which deep-links them to GitHub's edit-file page on public-registry.json
 * with a ready-to-edit JSON entry. Curation = standard PR review.
 */

import { useEffect, useState } from 'react'
import { fetchRegistry, type RegistryEntry } from '../lib/publicGithub'

interface Props {
  onOpenProject: (owner: string, repo: string) => void
  onBackToLanding: () => void
}

const SUBMIT_URL =
  'https://github.com/ccantynz-alt/HoldenMercer.com/edit/main/frontend/public/public-registry.json'

export function Discover({ onOpenProject, onBackToLanding }: Props) {
  const [entries, setEntries] = useState<RegistryEntry[] | null>(null)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    document.title = 'Discover — Holden Mercer'
    fetchRegistry()
      .then(setEntries)
      .catch((err) => setError((err as Error).message))
    return () => { document.title = 'Holden Mercer — AI Builder Console' }
  }, [])

  return (
    <div className="hm-discover">
      <header className="hm-discover-header">
        <button className="hm-link-btn" onClick={onBackToLanding}>← landing</button>
        <a className="hm-btn-ghost" href={SUBMIT_URL} target="_blank" rel="noreferrer">
          Submit yours →
        </a>
      </header>

      <section className="hm-discover-hero">
        <h1 className="hm-discover-title">Public showcase</h1>
        <p className="hm-discover-lede">
          Holden Mercer projects whose owners have made them discoverable.
          Each card is a real GitHub repo with brief, sessions, and Actions
          gates visible. Anyone can fork. Anyone can submit theirs by editing
          the curated registry.
        </p>
      </section>

      {error && <div className="hm-public-error">{error}</div>}

      {entries === null && !error && (
        <div className="hm-public-loading">Loading registry…</div>
      )}

      {entries && (
        <div className="hm-discover-grid">
          {entries.map((e) => (
            <button
              key={`${e.owner}/${e.repo}`}
              className="hm-discover-card"
              onClick={() => onOpenProject(e.owner, e.repo)}
            >
              <div className="hm-discover-card-meta">
                <span className="hm-discover-card-category">{e.category}</span>
                <span className="hm-discover-card-date">{e.added_at}</span>
              </div>
              <h3 className="hm-discover-card-title">{e.title}</h3>
              <p className="hm-discover-card-tagline">{e.tagline}</p>
              <p className="hm-discover-card-repo">{e.owner}/{e.repo}</p>
            </button>
          ))}
        </div>
      )}

      {entries && entries.length === 0 && (
        <div className="hm-discover-empty">
          No projects yet. Be first —{' '}
          <a href={SUBMIT_URL} target="_blank" rel="noreferrer">submit yours</a>.
        </div>
      )}
    </div>
  )
}
