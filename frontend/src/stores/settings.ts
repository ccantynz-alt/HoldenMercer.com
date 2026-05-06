/**
 * Settings store — user-level config, persisted to localStorage.
 *
 * BYOK Anthropic key, GitHub PAT, autonomy + model defaults, plus the
 * dockable-pane state for the multi-pane workspace (PR #4 / killer #4).
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type AutonomyMode  = 'manual' | 'smart' | 'auto'
export type DockablePane  = 'brief' | 'preview' | 'gate' | 'tasks' | 'memory' | 'swarm'

interface SettingsState {
  anthropicKey:  string
  githubToken:   string         // PAT used by read_github_file / list_github_repos
  githubOrg:     string         // default owner for `list_github_repos`
  autonomy:      AutonomyMode
  defaultModel:  string
  /** When set + viewport is wide enough, this pane docks to the right of the
   *  active tab so e.g. Console + Preview can sit side-by-side. */
  dockedPane:    DockablePane | null
  /** Width of the docked pane in pixels. Persisted so it sticks across reloads. */
  dockedWidth:   number
  /** Self-repair: the dashboard's OWN repo. When set, the "Fix this" button
   *  + the error-boundary "Send to Claude" path dispatch background tasks
   *  against THIS repo so Claude can read + edit Holden Mercer itself. */
  selfRepairRepo:    string
  selfRepairBranch:  string
  setAnthropicKey: (key: string) => void
  setGithubToken:  (key: string) => void
  setGithubOrg:    (org: string) => void
  setAutonomy:     (mode: AutonomyMode) => void
  setDefaultModel: (model: string) => void
  setDockedPane:   (pane: DockablePane | null) => void
  setDockedWidth:  (px: number) => void
  setSelfRepairRepo:   (repo: string) => void
  setSelfRepairBranch: (branch: string) => void
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      anthropicKey: '',
      githubToken:  '',
      githubOrg:    '',
      autonomy:     'smart',
      defaultModel: 'claude-haiku-4-5-20251001',
      dockedPane:   null,
      dockedWidth:  480,
      selfRepairRepo:   '',
      selfRepairBranch: '',
      setAnthropicKey: (key)   => set({ anthropicKey: key.trim() }),
      setGithubToken:  (key)   => set({ githubToken: key.trim() }),
      setGithubOrg:    (org)   => set({ githubOrg: org.trim() }),
      setAutonomy:     (mode)  => set({ autonomy: mode }),
      setDefaultModel: (model) => set({ defaultModel: model }),
      setDockedPane:   (pane)  => set({ dockedPane: pane }),
      setDockedWidth:  (px)    => set({ dockedWidth: Math.max(280, Math.min(960, Math.round(px))) }),
      setSelfRepairRepo:   (repo)   => set({ selfRepairRepo: repo.trim() }),
      setSelfRepairBranch: (branch) => set({ selfRepairBranch: branch.trim() }),
    }),
    { name: 'holdenmercer:settings:v1' }
  )
)
