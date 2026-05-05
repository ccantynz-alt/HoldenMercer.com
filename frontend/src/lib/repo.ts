/**
 * Repo client — talks to /api/repo/* on the backend, which proxies to GitHub.
 *
 * The backend resolves the GitHub PAT (per-request override or env-configured
 * GLUECRON_GITHUB_TOKEN), so the frontend can pass an empty string and let the
 * backend fall back to the environment if it has one configured.
 */

import { authFetch } from '../stores/auth'
import { useSettings } from '../stores/settings'

export interface RepoSummary {
  full_name:      string
  name:           string
  private:        boolean
  description:    string
  default_branch: string
  updated_at:     string | null
  html_url:       string
}

export interface DirItem {
  name: string
  path: string
  type: 'file' | 'dir' | 'symlink' | string
  size: number
  sha:  string
  html_url: string
}

function token(): string {
  return useSettings.getState().githubToken || ''
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await authFetch(path, {
    method: 'POST',
    body: JSON.stringify({ ...body, github_token: token() }),
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(detail.detail || `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export async function listRepos(search?: string): Promise<RepoSummary[]> {
  const { repos } = await post<{ repos: RepoSummary[] }>('/api/repo/repos', {
    search: search ?? null,
  })
  return repos
}

export async function readFile(repo: string, path: string, ref?: string): Promise<string> {
  const { content } = await post<{ content: string }>('/api/repo/file/read', {
    repo, path, ref: ref ?? null,
  })
  return content
}

export async function writeFile(input: {
  repo:           string
  path:           string
  content:        string
  commit_message: string
  branch?:        string
}): Promise<string> {
  const { result } = await post<{ result: string }>('/api/repo/file/write', input)
  return result
}

export async function listDir(repo: string, path: string = '', ref?: string): Promise<DirItem[]> {
  const { items } = await post<{ items: DirItem[] }>('/api/repo/dir', {
    repo, path, ref: ref ?? null,
  })
  return items
}

/** Convenience: write the given content to .holdenmercer/<filename>. */
export async function writeMeta(
  repo: string,
  filename: string,
  content: string,
  commit_message: string,
): Promise<string> {
  return writeFile({
    repo,
    path: `.holdenmercer/${filename}`,
    content,
    commit_message,
  })
}

// ── Pre-flight: "what's just happened in this repo?" ──────────────────────
//
// Used by the Console on session start so the agent doesn't make decisions
// against stale state. Three lightweight reads — wrapped here to keep the
// caller code clean.

export interface RecentCommit {
  sha:     string
  message: string
  author:  string | null
  date:    string
  url:     string
}

export interface OpenPR {
  number: number
  title:  string
  head:   string
  base:   string
  author: string | null
  url:    string
  updated_at: string
}

export interface InProgressRun {
  id:        number
  workflow:  string
  branch:    string
  status:    string
  url:       string
  started:   string
}

export interface ActiveWorkClaim {
  branch:    string
  agent:     string                  // 'console' | 'background:<task_id>' | 'manual:<who>'
  scope:     string[]                // file paths the agent declared it'll touch
  startedAt: string                  // ISO
  intent:    string                  // one-sentence goal of this branch
}

export interface ActiveWorkManifest {
  version:  number
  active:   ActiveWorkClaim[]
}

const _ghHeaders = (token: string) => ({
  'Authorization':         `Bearer ${token}`,
  'Accept':                'application/vnd.github+json',
  'X-GitHub-Api-Version':  '2022-11-28',
})

export async function recentCommits(
  repo: string, branch: string | null, limit = 10,
): Promise<RecentCommit[]> {
  const tok = token()
  if (!repo || !tok) return []
  const url = new URL(`https://api.github.com/repos/${repo}/commits`)
  if (branch) url.searchParams.set('sha', branch)
  url.searchParams.set('per_page', String(limit))
  const r = await fetch(url.toString(), { headers: _ghHeaders(tok) })
  if (!r.ok) return []
  const items = await r.json()
  if (!Array.isArray(items)) return []
  return items.map((it: any) => ({
    sha:     (it.sha || '').slice(0, 7),
    message: (it.commit?.message || '').split('\n', 1)[0],
    author:  it.commit?.author?.name || it.author?.login || null,
    date:    it.commit?.author?.date || '',
    url:     it.html_url || '',
  }))
}

export async function openPullRequests(repo: string, limit = 10): Promise<OpenPR[]> {
  const tok = token()
  if (!repo || !tok) return []
  const url = `https://api.github.com/repos/${repo}/pulls?state=open&per_page=${limit}&sort=updated&direction=desc`
  const r = await fetch(url, { headers: _ghHeaders(tok) })
  if (!r.ok) return []
  const items = await r.json()
  if (!Array.isArray(items)) return []
  return items.map((it: any) => ({
    number: it.number,
    title:  it.title,
    head:   it.head?.ref || '',
    base:   it.base?.ref || '',
    author: it.user?.login || null,
    url:    it.html_url || '',
    updated_at: it.updated_at,
  }))
}

export async function inProgressRuns(repo: string, limit = 5): Promise<InProgressRun[]> {
  const tok = token()
  if (!repo || !tok) return []
  // Pull both "queued" and "in_progress" runs across all workflows
  const out: InProgressRun[] = []
  for (const status of ['queued', 'in_progress']) {
    const r = await fetch(
      `https://api.github.com/repos/${repo}/actions/runs?status=${status}&per_page=${limit}`,
      { headers: _ghHeaders(tok) },
    )
    if (!r.ok) continue
    const data = await r.json()
    for (const run of (data.workflow_runs || [])) {
      out.push({
        id:       run.id,
        workflow: run.name || run.path || 'workflow',
        branch:   run.head_branch || '',
        status:   run.status || status,
        url:      run.html_url || '',
        started:  run.run_started_at || run.created_at || '',
      })
    }
  }
  return out
}

export async function readActiveWork(repo: string, branch?: string): Promise<ActiveWorkManifest> {
  try {
    const text = await readFile(repo, '.holdenmercer/active-work.json', branch)
    const parsed = JSON.parse(text)
    if (!parsed || !Array.isArray(parsed.active)) return { version: 1, active: [] }
    return parsed
  } catch {
    return { version: 1, active: [] }
  }
}
