/**
 * PublicProject — read-only public view of any Holden Mercer-tracked project.
 *
 * Reached at #p/<owner>/<repo>. Fetches data straight from GitHub's public
 * API and raw CDN — no Holden Mercer backend involved, no auth required.
 * Anyone can share the URL; anyone can read it.
 *
 * Renders:
 *   • Repo metadata header (name, description, stars, forks, language)
 *   • Brief (Markdown) from .holdenmercer/brief.md
 *   • Recent sessions from .holdenmercer/sessions/ — a compact timeline
 *   • Click-through to GitHub for the repo, the workflow runs, etc.
 *
 * Falls back gracefully when a section isn't present (private repo, no
 * brief, no sessions yet).
 */

import { lazy, Suspense, useEffect, useState } from 'react'
import {
  fetchPublicBrief, fetchPublicRepo, fetchPublicSession, fetchPublicSessions,
  type PublicRepoMeta, type PublicSession,
} from '../lib/publicGithub'

const Markdown = lazy(() => import('./Markdown').then((m) => ({ default: m.Markdown })))

interface Props {
  owner: string
  repo:  string
  onBack: () => void
}

export function PublicProject({ owner, repo, onBack }: Props) {
  const [meta,     setMeta]     = useState<PublicRepoMeta | null>(null)
  const [brief,    setBrief]    = useState<string | null>(null)
  const [sessions, setSessions] = useState<PublicSession[]>([])
  const [openSession, setOpenSession] = useState<string | null>(null)
  const [openBody,    setOpenBody]    = useState<string | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setBrief(null)
    setSessions([])
    setOpenSession(null)
    setOpenBody(null)

    ;(async () => {
      try {
        const m = await fetchPublicRepo(owner, repo)
        if (!m) {
          if (!cancelled) {
            setError('This repo is private or doesn’t exist on GitHub.')
            setLoading(false)
          }
          return
        }
        if (cancelled) return
        setMeta(m)
        const branch = m.default_branch || 'main'
        const [b, s] = await Promise.all([
          fetchPublicBrief(owner, repo, branch),
          fetchPublicSessions(owner, repo, branch),
        ])
        if (cancelled) return
        setBrief(b)
        setSessions(s)
      } catch (err) {
        if (!cancelled) setError((err as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [owner, repo])

  // Update document title + meta description for shareable previews
  useEffect(() => {
    if (!meta) return
    const title = `${meta.full_name} — Holden Mercer`
    document.title = title
    const desc = meta.description?.slice(0, 200) ?? `Public Holden Mercer project ${meta.full_name}.`
    upsertMeta('description', desc)
    upsertProperty('og:title',       title)
    upsertProperty('og:description', desc)
    upsertProperty('og:type',        'website')
    upsertProperty('og:url',         window.location.href)
    return () => {
      document.title = 'Holden Mercer — AI Builder Console'
    }
  }, [meta])

  const openSessionFile = async (name: string) => {
    if (!meta) return
    if (openSession === name) {
      setOpenSession(null); setOpenBody(null); return
    }
    setOpenSession(name)
    setOpenBody(null)
    const branch = meta.default_branch || 'main'
    const body   = await fetchPublicSession(owner, repo, branch, name)
    setOpenBody(body ?? '[could not fetch]')
  }

  return (
    <div className="hm-public">
      <header className="hm-public-header">
        <button className="hm-link-btn" onClick={onBack}>← back</button>
        {meta && (
          <a className="hm-public-gh" href={meta.html_url} target="_blank" rel="noreferrer">
            View on GitHub ↗
          </a>
        )}
      </header>

      {loading && <div className="hm-public-loading">Loading {owner}/{repo}…</div>}
      {error   && <div className="hm-public-error">{error}</div>}

      {meta && (
        <>
          <section className="hm-public-meta">
            <h1 className="hm-public-title">{meta.full_name}</h1>
            {meta.description && <p className="hm-public-tagline">{meta.description}</p>}
            <div className="hm-public-stats">
              {meta.language && <span>{meta.language}</span>}
              <span>★ {meta.stargazers_count.toLocaleString()}</span>
              <span>⑂ {meta.forks_count.toLocaleString()}</span>
              {meta.license?.spdx_id && <span>{meta.license.spdx_id}</span>}
              {meta.homepage && (
                <a href={meta.homepage} target="_blank" rel="noreferrer">{shortUrl(meta.homepage)} ↗</a>
              )}
            </div>
            {meta.topics?.length > 0 && (
              <div className="hm-public-topics">
                {meta.topics.slice(0, 8).map((t) => (
                  <span key={t} className="hm-public-topic">{t}</span>
                ))}
              </div>
            )}
          </section>

          {brief && (
            <section className="hm-public-section">
              <h2 className="hm-public-section-title">Brief</h2>
              <Suspense fallback={<pre className="hm-public-fallback">{brief}</pre>}>
                <Markdown text={brief} />
              </Suspense>
            </section>
          )}

          <section className="hm-public-section">
            <h2 className="hm-public-section-title">
              Sessions {sessions.length > 0 ? `(${sessions.length})` : ''}
            </h2>
            {sessions.length === 0 ? (
              <p className="hm-public-empty">
                No public sessions yet. The owner hasn’t opened the Console on this
                project — or the repo doesn’t have a <code>.holdenmercer/sessions/</code>
                directory.
              </p>
            ) : (
              <ul className="hm-public-sessions">
                {sessions.slice(0, 25).map((s) => (
                  <li key={s.name} className={`hm-public-session${openSession === s.name ? ' is-open' : ''}`}>
                    <button
                      className="hm-public-session-row"
                      onClick={() => openSessionFile(s.name)}
                    >
                      <span className="hm-public-session-time">
                        {s.timestamp ? new Date(s.timestamp).toLocaleString() : '—'}
                      </span>
                      <span className="hm-public-session-name">{s.name.replace(/\.md$/, '')}</span>
                    </button>
                    {openSession === s.name && (
                      <div className="hm-public-session-body">
                        {openBody === null ? (
                          'Loading…'
                        ) : (
                          <Suspense fallback={<pre className="hm-public-fallback">{openBody}</pre>}>
                            <Markdown text={openBody} />
                          </Suspense>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  )
}

function shortUrl(u: string): string {
  try { return new URL(u).hostname.replace(/^www\./, '') } catch { return u }
}

function upsertMeta(name: string, content: string) {
  let el = document.querySelector(`meta[name="${name}"]`) as HTMLMetaElement | null
  if (!el) {
    el = document.createElement('meta')
    el.name = name
    document.head.appendChild(el)
  }
  el.content = content
}

function upsertProperty(property: string, content: string) {
  let el = document.querySelector(`meta[property="${property}"]`) as HTMLMetaElement | null
  if (!el) {
    el = document.createElement('meta')
    el.setAttribute('property', property)
    document.head.appendChild(el)
  }
  el.content = content
}
