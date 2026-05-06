/**
 * gatetest.ai client — calls the backend /api/gatetest/scan proxy which
 * forwards to gatetest.ai/api/v1/scan with the user's gt_live_... key.
 */

import { authFetch } from '../stores/auth'
import { useSettings } from '../stores/settings'

export interface GatetestModule {
  name:           string
  status:         'passed' | 'failed' | 'skipped'
  checks?:        number
  issues?:        number
  duration?:      number
  details?:       string[]
  skipped?:       boolean
}

export interface GatetestScanResult {
  status:           string
  repo_url:         string
  tier:             string
  modules:          GatetestModule[]
  totalModules:     number
  completedModules: number
  totalIssues:      number
  duration:         number
  authSource?:      string
  key?:             string
}

export async function scanRepo(
  repoFullName: string, tier: 'quick' | 'full' = 'full',
): Promise<GatetestScanResult> {
  const key = useSettings.getState().gatetestKey
  const repo_url = `https://github.com/${repoFullName}`
  const res = await authFetch('/api/gatetest/scan', {
    method: 'POST',
    body:   JSON.stringify({ repo_url, tier, gatetest_key: key }),
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(detail.detail || `HTTP ${res.status}`)
  }
  return res.json()
}
