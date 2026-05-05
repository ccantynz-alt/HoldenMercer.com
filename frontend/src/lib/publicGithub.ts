/**
 * Public GitHub fetch — read-only, unauthenticated.
 *
 * Hits GitHub's public API directly from the browser. Works for any public
 * repo. Rate-limited to 60 req/hour per IP (unauth), but cached aggressively
 * by the browser via the `If-None-Match` ETag dance + the CDN. Plenty for
 * showcase pages.
 *
 * If a project has gone public on GitHub but its `.holdenmercer/` folder
 * doesn't exist yet, the helpers degrade to the "no data" path gracefully.
 */

const GH_API = 'https://api.github.com'
const GH_RAW = 'https://raw.githubusercontent.com'

export interface PublicRepoMeta {
  full_name:      string
  description:    string | null
  html_url:       string
  homepage:       string | null
  stargazers_count: number
  forks_count:    number
  default_branch: string
  topics:         string[]
  language:       string | null
  pushed_at:      string
  license:        { spdx_id: string | null } | null
}

export interface PublicSession {
  name:     string         // filename, e.g. 2026-05-04-093210.md
  path:     string
  size:     number
  html_url: string
  /** Parsed timestamp from the filename, ms since epoch. 0 if unparseable. */
  timestamp: number
}

export async function fetchPublicRepo(owner: string, repo: string): Promise<PublicRepoMeta | null> {
  const r = await fetch(`${GH_API}/repos/${owner}/${repo}`)
  if (!r.ok) return null
  return r.json()
}

export async function fetchPublicBrief(owner: string, repo: string, branch: string): Promise<string | null> {
  const r = await fetch(`${GH_RAW}/${owner}/${repo}/${branch}/.holdenmercer/brief.md`)
  if (!r.ok) return null
  return r.text()
}

export async function fetchPublicSessions(owner: string, repo: string, branch: string): Promise<PublicSession[]> {
  const r = await fetch(`${GH_API}/repos/${owner}/${repo}/contents/.holdenmercer/sessions?ref=${encodeURIComponent(branch)}`)
  if (!r.ok) return []
  const items = await r.json()
  if (!Array.isArray(items)) return []
  return items
    .filter((it: { type?: string; name?: string }) => it.type === 'file' && it.name?.endsWith('.md'))
    .map((it: { name: string; path: string; size: number; html_url: string }) => ({
      name:      it.name,
      path:      it.path,
      size:      it.size,
      html_url:  it.html_url,
      timestamp: parseSessionTimestamp(it.name),
    }))
    .sort((a: PublicSession, b: PublicSession) => b.timestamp - a.timestamp)
}

export async function fetchPublicSession(
  owner: string, repo: string, branch: string, name: string,
): Promise<string | null> {
  const r = await fetch(`${GH_RAW}/${owner}/${repo}/${branch}/.holdenmercer/sessions/${name}`)
  if (!r.ok) return null
  return r.text()
}

export interface RegistryEntry {
  owner:    string
  repo:     string
  title:    string
  tagline:  string
  category: string
  added_at: string
}

export async function fetchRegistry(): Promise<RegistryEntry[]> {
  const r = await fetch('/public-registry.json', { cache: 'no-cache' })
  if (!r.ok) return []
  const data = await r.json()
  return (data?.projects ?? []) as RegistryEntry[]
}

function parseSessionTimestamp(name: string): number {
  const m = name.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})\.md$/)
  if (!m) return 0
  const [, y, mo, d, h, mi, s] = m
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)
}
