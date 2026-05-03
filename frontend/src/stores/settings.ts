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
  autonomy:      AutonomyMode
  defaultModel:  string
  setAnthropicKey: (key: string) => void
  setAutonomy:     (mode: AutonomyMode) => void
  setDefaultModel: (model: string) => void
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      anthropicKey: '',
      autonomy:     'smart',
      defaultModel: 'claude-opus-4-7',
      setAnthropicKey: (key)  => set({ anthropicKey: key.trim() }),
      setAutonomy:     (mode) => set({ autonomy: mode }),
      setDefaultModel: (model) => set({ defaultModel: model }),
    }),
    { name: 'holdenmercer:settings:v1' }
  )
)
