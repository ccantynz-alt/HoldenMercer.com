/**
 * Gate client — talks to /api/repo/gate/* on the backend.
 *
 * The backend wraps GitHub Actions: install a workflow, trigger runs, poll
 * for status, fetch logs. Read-only-from-the-frontend except for `setup` and
 * `run`, which mutate state in your repo.
 */

import { authFetch } from '../stores/auth'
import { useSettings } from '../stores/settings'

export interface GateRun {
  id:         number
  status:     'queued' | 'in_progress' | 'completed' | string
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | null
  branch:     string
  head_sha:   string
  created_at: string
  updated_at: string
  html_url:   string
  event:      string
  actor:      string | null
}

function token(): string {
  return useSettings.getState().githubToken || ''
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await authFetch(path, {
    method: 'POST',
    body:   JSON.stringify({ ...body, github_token: token() }),
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(detail.detail || `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export async function setupGate(repo: string, branch?: string): Promise<string> {
  const { result } = await post<{ result: string }>('/api/repo/gate/setup', { repo, branch: branch ?? null })
  return result
}

export async function runGate(repo: string, branch?: string): Promise<string> {
  const { result } = await post<{ result: string }>('/api/repo/gate/run', { repo, branch: branch ?? null })
  return result
}

export async function listGateRuns(
  repo: string, branch?: string,
): Promise<{ runs: GateRun[]; workflow_installed: boolean }> {
  return post('/api/repo/gate/runs', { repo, branch: branch ?? null })
}

export async function gateStatus(repo: string, run_id: number | string): Promise<string> {
  const { result } = await post<{ result: string }>('/api/repo/gate/status', { repo, run_id })
  return result
}

export async function gateLogs(repo: string, run_id: number | string): Promise<string> {
  const { logs } = await post<{ logs: string }>('/api/repo/gate/logs', { repo, run_id })
  return logs
}
