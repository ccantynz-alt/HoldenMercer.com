/**
 * Settings store — user-level config, persisted to localStorage.
 *
 * BYOK Anthropic key lives here. PR B will pass it to the backend on every
 * Console request so we never store it server-side.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type AutonomyMode = 'manual' | 'smart' | 'auto'

interface SettingsState {
  anthropicKey:  string
  githubToken:   string         // PAT used by read_github_file / list_github_repos
  githubOrg:     string         // default owner for `list_github_repos`
  autonomy:      AutonomyMode
  defaultModel:  string
  setAnthropicKey: (key: string) => void
  setGithubToken:  (key: string) => void
  setGithubOrg:    (org: string) => void
  setAutonomy:     (mode: AutonomyMode) => void
  setDefaultModel: (model: string) => void
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      anthropicKey: '',
      githubToken:  '',
      githubOrg:    '',
      autonomy:     'smart',
      defaultModel: 'claude-opus-4-7',
      setAnthropicKey: (key)   => set({ anthropicKey: key.trim() }),
      setGithubToken:  (key)   => set({ githubToken: key.trim() }),
      setGithubOrg:    (org)   => set({ githubOrg: org.trim() }),
      setAutonomy:     (mode)  => set({ autonomy: mode }),
      setDefaultModel: (model) => set({ defaultModel: model }),
    }),
    { name: 'holdenmercer:settings:v1' }
  )
)
