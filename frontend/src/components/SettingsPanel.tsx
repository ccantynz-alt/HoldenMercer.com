/**
 * SettingsPanel — slide-over drawer for user-level config.
 *
 * Anthropic key (BYOK), GitHub PAT (for read_github_file / list_github_repos),
 * default autonomy, default model, sign out. Values live in localStorage via
 * the settings store.
 */

import { useEffect, useState } from 'react'
import { useSettings, type AutonomyMode } from '../stores/settings'
import { useAuth } from '../stores/auth'
import { notificationsSupported, permission, requestPermission } from '../lib/notify'

interface Props {
  open:    boolean
  onClose: () => void
}

const AUTONOMY_OPTIONS: { value: AutonomyMode; label: string; help: string }[] = [
  { value: 'manual', label: 'Manual',      help: 'Ask before every file edit. Slowest, safest.' },
  { value: 'smart',  label: 'Smart pause', help: 'Run free; pause on architecture, destructive ops, spend.' },
  { value: 'auto',   label: 'Full auto',   help: 'Run to completion. No pauses. Fastest, riskiest.' },
]

const MODEL_OPTIONS = [
  { value: 'claude-opus-4-7',           label: 'Opus 4.7 — most capable' },
  { value: 'claude-sonnet-4-6',         label: 'Sonnet 4.6 — balanced' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 — fast / cheap' },
]

function mask(value: string, prefix = 8, suffix = 4): string {
  if (!value) return ''
  if (value.length <= prefix + suffix) return value
  return `${value.slice(0, prefix)}…${value.slice(-suffix)}`
}

export function SettingsPanel({ open, onClose }: Props) {
  const [notifyState, setNotifyState] = useState(() => permission())

  useEffect(() => {
    if (!open) return
    setNotifyState(permission())
  }, [open])

  const enableNotifications = async () => {
    const next = await requestPermission()
    setNotifyState(next)
  }

  const anthropicKey  = useSettings((s) => s.anthropicKey)
  const githubToken   = useSettings((s) => s.githubToken)
  const githubOrg     = useSettings((s) => s.githubOrg)
  const autonomy      = useSettings((s) => s.autonomy)
  const defaultModel  = useSettings((s) => s.defaultModel)
  const setAnthropic  = useSettings((s) => s.setAnthropicKey)
  const setGhToken    = useSettings((s) => s.setGithubToken)
  const setGhOrg      = useSettings((s) => s.setGithubOrg)
  const setAutonomy   = useSettings((s) => s.setAutonomy)
  const setModel      = useSettings((s) => s.setDefaultModel)
  const email         = useAuth((s) => s.email)
  const logout        = useAuth((s) => s.logout)

  if (!open) return null

  return (
    <div className="hm-drawer-backdrop" onClick={onClose}>
      <div className="hm-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="hm-drawer-header">
          <h2 className="hm-drawer-title">Settings</h2>
          <button className="hm-icon-btn" onClick={onClose} aria-label="Close">×</button>
        </div>

        <section className="hm-drawer-section">
          <h3 className="hm-drawer-section-title">Anthropic API key</h3>
          <p className="hm-drawer-help">
            Your <code>sk-ant-…</code> key. Stored in this browser only — sent
            to the backend on each Console request, never persisted server-side.
          </p>
          <input
            className="hm-input"
            type="password"
            value={anthropicKey}
            onChange={(e) => setAnthropic(e.target.value)}
            placeholder="sk-ant-…"
            autoComplete="off"
            spellCheck={false}
          />
          {anthropicKey && (
            <p className="hm-drawer-confirm">Saved: <code>{mask(anthropicKey)}</code></p>
          )}
        </section>

        <section className="hm-drawer-section">
          <h3 className="hm-drawer-section-title">GitHub (GlueCron)</h3>
          <p className="hm-drawer-help">
            A personal access token with <code>repo</code> scope. Lets the Console
            read files from any of your repositories. Get one at{' '}
            <a href="https://github.com/settings/tokens" target="_blank" rel="noreferrer">
              github.com/settings/tokens
            </a>.
          </p>
          <input
            className="hm-input"
            type="password"
            value={githubToken}
            onChange={(e) => setGhToken(e.target.value)}
            placeholder="github_pat_…"
            autoComplete="off"
            spellCheck={false}
          />
          {githubToken && (
            <p className="hm-drawer-confirm">Saved: <code>{mask(githubToken)}</code></p>
          )}
          <input
            className="hm-input"
            type="text"
            value={githubOrg}
            onChange={(e) => setGhOrg(e.target.value)}
            placeholder="GitHub username or org (e.g. ccantynz-alt)"
            autoComplete="off"
            spellCheck={false}
            style={{ marginTop: 8 }}
          />
        </section>

        <section className="hm-drawer-section">
          <h3 className="hm-drawer-section-title">Default autonomy</h3>
          <p className="hm-drawer-help">
            How aggressive the Console runs. Per-project override coming in PR C.
          </p>
          <div className="hm-radio-group">
            {AUTONOMY_OPTIONS.map((opt) => (
              <label key={opt.value} className="hm-radio">
                <input
                  type="radio"
                  name="autonomy"
                  value={opt.value}
                  checked={autonomy === opt.value}
                  onChange={() => setAutonomy(opt.value)}
                />
                <span>
                  <strong>{opt.label}</strong>
                  <span className="hm-radio-help">{opt.help}</span>
                </span>
              </label>
            ))}
          </div>
        </section>

        <section className="hm-drawer-section">
          <h3 className="hm-drawer-section-title">Default model</h3>
          <select
            className="hm-input"
            value={defaultModel}
            onChange={(e) => setModel(e.target.value)}
          >
            {MODEL_OPTIONS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </section>

        <section className="hm-drawer-section">
          <h3 className="hm-drawer-section-title">Notifications</h3>
          <p className="hm-drawer-help">
            Get a desktop / iOS lock-screen notification when a background
            task completes. Works while the dashboard tab is open. For full
            push (closed tab), <strong>install as a PWA</strong>: on iPad
            Safari → Share → Add to Home Screen.
          </p>
          {!notificationsSupported() ? (
            <p className="hm-drawer-confirm" style={{ color: 'var(--text-muted)' }}>
              Not supported in this browser.
            </p>
          ) : notifyState === 'granted' ? (
            <p className="hm-drawer-confirm">Enabled ✓</p>
          ) : notifyState === 'denied' ? (
            <p className="hm-drawer-confirm" style={{ color: 'var(--error)' }}>
              Blocked. Re-enable from your browser's site settings.
            </p>
          ) : (
            <button className="hm-btn-primary" onClick={enableNotifications}>
              Enable browser notifications
            </button>
          )}
        </section>

        <section className="hm-drawer-section">
          <h3 className="hm-drawer-section-title">Account</h3>
          <p className="hm-drawer-help">
            Signed in as <code>{email ?? 'unknown'}</code>.
          </p>
          <button
            className="hm-btn-ghost"
            onClick={() => { logout(); onClose() }}
          >
            Sign out
          </button>
        </section>
      </div>
    </div>
  )
}
