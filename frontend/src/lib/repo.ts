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
