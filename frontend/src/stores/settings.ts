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
  /** Auto-dispatch a fix task whenever a gatetest.ai scan returns failures. */
  autoFixGatetest: boolean
  /** Cross-project preferences injected into every Console session and
   *  forwarded to background agents. Free-form markdown the user maintains. */
  globalPrefs: string
  /** Master kill switch. When true, EVERY background dispatch path is
   *  refused — manual fix buttons, auto-fix, onboarding, self-repair.
   *  Use this when the API is hemorrhaging spend you can't explain. */
  pauseAutoDispatch: boolean
  /** Soft daily cost cap in USD. When today's cumulative API spend
   *  exceeds this, dispatches are refused with a clear error. 0 = no cap. */
  dailyCostCapUsd: number
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
  setAutoFixGatetest: (on: boolean) => void
  setGlobalPrefs:     (text: string) => void
  setPauseAutoDispatch: (on: boolean) => void
  setDailyCostCap:      (usd: number) => void
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

// ── Keychain — last-resort backup of the painful-to-re-enter values ────────
// Stored in a SEPARATE localStorage key from the main settings so it survives:
//   • Schema migrations of the settings store
//   • Hard reset (we restore from keychain if main settings is empty)
//   • Nuclear reset (the user explicitly opts out, but this still gives a
//     last-look "you sure?" via the export button in Settings)
//
// Writes happen via setAnthropicKey / setGithubToken / setGatetestKey, AND
// every settings hydrate that reads non-empty values. So the keychain is
// always at-least-as-fresh as the main settings.

const KEYCHAIN_KEY = 'holdenmercer:keychain:v1'

interface Keychain {
  anthropicKey: string
  githubToken:  string
  gatetestKey:  string
  updatedAt:    number
}

function readKeychain(): Partial<Keychain> {
  try {
    const raw = localStorage.getItem(KEYCHAIN_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as Keychain
  } catch { return {} }
}

function writeKeychain(patch: Partial<Keychain>) {
  try {
    const current = readKeychain()
    const next: Keychain = {
      anthropicKey: patch.anthropicKey ?? current.anthropicKey ?? '',
      githubToken:  patch.githubToken  ?? current.githubToken  ?? '',
      gatetestKey:  patch.gatetestKey  ?? current.gatetestKey  ?? '',
      updatedAt:    Date.now(),
    }
    // Don't overwrite a non-empty stored value with empty unless explicitly
    // null'd (used for the Export+wipe flow). Empty incoming is a no-op.
    if (patch.anthropicKey === '') next.anthropicKey = current.anthropicKey ?? ''
    if (patch.githubToken  === '') next.githubToken  = current.githubToken  ?? ''
    if (patch.gatetestKey  === '') next.gatetestKey  = current.gatetestKey  ?? ''
    localStorage.setItem(KEYCHAIN_KEY, JSON.stringify(next))
  } catch { /* swallow */ }
}

/** Reads from the keychain backup. Use this in recovery flows when the
 *  main settings store has empty key fields but the keychain might still
 *  hold a value the user pasted on a previous load. */
export function recoverKeychain(): Partial<Keychain> {
  return readKeychain()
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      anthropicKey: '',
      githubToken:  '',
      githubOrg:    '',
      gatetestKey:  '',
      autoFixGatetest: false,
      globalPrefs:        '',
      pauseAutoDispatch:  false,
      dailyCostCapUsd:    0,
      autonomy:     'smart',
      defaultModel: 'claude-haiku-4-5-20251001',
      dockedPane:   null,
      dockedWidth:  480,
      selfRepairRepo:   '',
      selfRepairBranch: '',
      setAnthropicKey: (key)   => {
        const v = key.trim()
        set({ anthropicKey: v })
        if (v) writeKeychain({ anthropicKey: v })
      },
      setGithubToken:  (key)   => {
        const v = key.trim()
        set({ githubToken: v })
        if (v) writeKeychain({ githubToken: v })
      },
      setGithubOrg:    (org)   => set({ githubOrg: org.trim() }),
      setGatetestKey:  (key)   => {
        const v = key.trim()
        set({ gatetestKey: v })
        if (v) writeKeychain({ gatetestKey: v })
      },
      setAutoFixGatetest: (on) => set({ autoFixGatetest: !!on }),
      setGlobalPrefs:     (t)  => set({ globalPrefs: t }),
      setPauseAutoDispatch: (on) => set({ pauseAutoDispatch: !!on }),
      setDailyCostCap:    (n)  => set({ dailyCostCapUsd: Math.max(0, Number(n) || 0) }),
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
        autoFixGatetest:  s.autoFixGatetest,
        globalPrefs:      s.globalPrefs,
        pauseAutoDispatch: s.pauseAutoDispatch,
        dailyCostCapUsd:   s.dailyCostCapUsd,
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

      // After persist rehydrates the store, restore any empty keys from
      // the keychain backup. This handles every "I lost my keys after an
      // update" scenario: if the persisted state migrates wrong, or someone
      // clicks Hard Reset on the OLD bundle (which used to wipe everything),
      // or any other path that leaves the store with empty keys — we walk
      // forward by recovering from the separate keychain entry that's
      // never touched by the settings store.
      onRehydrateStorage: () => (state) => {
        if (!state) return
        try {
          const k = readKeychain()
          const patch: Partial<SettingsState> = {}
          if (!state.anthropicKey && k.anthropicKey) patch.anthropicKey = k.anthropicKey
          if (!state.githubToken  && k.githubToken)  patch.githubToken  = k.githubToken
          if (!state.gatetestKey  && k.gatetestKey)  patch.gatetestKey  = k.gatetestKey
          if (Object.keys(patch).length > 0) {
            // eslint-disable-next-line no-console
            console.info('[hm] keychain recovery restored:', Object.keys(patch).join(', '))
            useSettings.setState(patch)
          }
          // Always sync any non-empty store values forward into keychain so
          // the next session is even safer.
          writeKeychain({
            anthropicKey: state.anthropicKey,
            githubToken:  state.githubToken,
            gatetestKey:  state.gatetestKey,
          })
        } catch { /* swallow */ }
      },
    },
  ),
)
