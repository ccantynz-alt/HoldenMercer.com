/**
 * Background tasks client — talks to /api/jobs/* on the backend.
 *
 * Tasks are dispatched as workflow_dispatch runs of holden-mercer-task.yml
 * in the project's repo. The agent runs inside GitHub Actions for up to
 * 6 hours, commits work as it goes, and writes a final summary to
 * .holdenmercer/tasks/<task_id>.md.
 */

import { authFetch } from '../stores/auth'
import { useSettings } from '../stores/settings'

export interface TaskRun {
  id:         number
  status:     'queued' | 'in_progress' | 'completed' | string
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | null
  branch:     string
  head_sha:   string
  created_at: string
  updated_at: string
  html_url:   string
  actor:      string | null
  name:       string
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

export async function setupTaskWorkflow(repo: string, branch?: string): Promise<{
  result: string; secret_setup_url: string
}> {
  return post('/api/jobs/setup', { repo, branch: branch ?? null })
}

export async function setupCronWorkflow(repo: string, branch?: string): Promise<{
  result: string; schedules_file_seeded: boolean; schedules_url: string
}> {
  return post('/api/jobs/setup-cron', { repo, branch: branch ?? null })
}

export async function dispatchTask(input: {
  repo:      string
  prompt:    string
  brief?:    string
  model?:    string
  max_iters?: number
  branch?:   string
}): Promise<{
  task_id:           string
  ref:               string
  actions_url:       string
  auto_installed?:   boolean
  secret_setup_url?: string | null
}> {
  return post('/api/jobs/dispatch', input)
}

export async function listTaskRuns(
  repo: string, branch?: string,
): Promise<{ runs: TaskRun[]; workflow_installed: boolean }> {
  return post('/api/jobs/list', { repo, branch: branch ?? null })
}

export async function fetchTaskResult(
  repo: string, task_id: string, branch?: string,
): Promise<{ content: string | null; found: boolean }> {
  return post('/api/jobs/result', { repo, task_id, branch: branch ?? null })
}

export async function cancelTaskRun(run_id: number): Promise<{ cancelled: boolean }> {
  return post('/api/jobs/cancel', { run_id })
}

export async function deleteTaskRun(run_id: number): Promise<{ deleted: boolean }> {
  return post('/api/jobs/delete-run', { run_id })
}

/** {set: true} secret exists, {set: false} missing, {set: null} unknown
 *  (PAT lacks admin scope to read secrets list). */
export async function checkRepoSecret(
  repo: string, secret_name = 'ANTHROPIC_API_KEY',
): Promise<{ set: boolean | null; secret_name: string; reason?: string }> {
  return post('/api/jobs/check-secret', { repo, secret_name })
}

export async function fetchRunLogs(run_id: number): Promise<{
  logs:   string
  status: string
  jobs:   Array<{ name: string; status: string; conclusion: string | null }>
}> {
  return post('/api/jobs/run-logs', { run_id })
}
