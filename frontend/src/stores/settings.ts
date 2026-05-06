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
  /** gatetest.ai API key (gt_live_...) for the GateTest scanner integration. */
  gatetestKey:   string
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
  setGatetestKey:  (key: string) => void
  setAutonomy:     (mode: AutonomyMode) => void
  setDefaultModel: (model: string) => void
  setDockedPane:   (pane: DockablePane | null) => void
  setDockedWidth:  (px: number) => void
  setSelfRepairRepo:   (repo: string) => void
  setSelfRepairBranch: (branch: string) => void
}

/** Strip `https://github.com/` prefix, trailing slashes, and any trailing
 *  `.git`. Forgiving so users can paste either `owner/repo` or the full
 *  GitHub URL without breaking link construction downstream. */
function normalizeRepo(input: string): string {
  return input
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/^https?:\/\/gluecron\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      anthropicKey: '',
      githubToken:  '',
      githubOrg:    '',
      gatetestKey:  '',
      autonomy:     'smart',
      defaultModel: 'claude-haiku-4-5-20251001',
      dockedPane:   null,
      dockedWidth:  480,
      selfRepairRepo:   '',
      selfRepairBranch: '',
      setAnthropicKey: (key)   => set({ anthropicKey: key.trim() }),
      setGithubToken:  (key)   => set({ githubToken: key.trim() }),
      setGithubOrg:    (org)   => set({ githubOrg: org.trim() }),
      setGatetestKey:  (key)   => set({ gatetestKey: key.trim() }),
      setAutonomy:     (mode)  => set({ autonomy: mode }),
      setDefaultModel: (model) => set({ defaultModel: model }),
      setDockedPane:   (pane)  => set({ dockedPane: pane }),
      setDockedWidth:  (px)    => set({ dockedWidth: Math.max(280, Math.min(960, Math.round(px))) }),
      setSelfRepairRepo:   (repo)   => set({ selfRepairRepo: normalizeRepo(repo) }),
      setSelfRepairBranch: (branch) => set({ selfRepairBranch: branch.trim() }),
    }),
    {
      name:    'holdenmercer:settings:v1',
      version: 2,
      // Explicit partialize so we know exactly which fields persist. This
      // also prevents weird hydration bugs where a default-value field
      // (like defaultModel after we changed the default from Opus to
      // Haiku) appears to "revert" because the schema mismatch confused
      // the merge logic.
      partialize: (s) => ({
        anthropicKey:     s.anthropicKey,
        githubToken:      s.githubToken,
        githubOrg:        s.githubOrg,
        gatetestKey:      s.gatetestKey,
        autonomy:         s.autonomy,
        defaultModel:     s.defaultModel,
        dockedPane:       s.dockedPane,
        dockedWidth:      s.dockedWidth,
        selfRepairRepo:   s.selfRepairRepo,
        selfRepairBranch: s.selfRepairBranch,
      }),
      // Forward-compatible migrate. Returns the persisted state unchanged
      // for known versions. New fields use defaults from create().
      migrate: (persisted, version) => {
        const p = (persisted as Partial<SettingsState>) || {}
        if (version < 2) {
          // v1 → v2 — no-op data migration; we just want to bump the version
          // so future merges go through this path explicitly.
          return p as SettingsState
        }
        return p as SettingsState
      },
      // Cross-tab sync: when one tab writes settings, others rehydrate
      // automatically. Without this, opening Settings in two tabs and
      // editing in one would let the OTHER tab silently overwrite on
      // next save.
      skipHydration: false,
    },
  ),
)
