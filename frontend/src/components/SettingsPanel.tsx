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

  const anthropicKey     = useSettings((s) => s.anthropicKey)
  const githubToken      = useSettings((s) => s.githubToken)
  const githubOrg        = useSettings((s) => s.githubOrg)
  const gatetestKey      = useSettings((s) => s.gatetestKey)
  const autoFixGatetest  = useSettings((s) => s.autoFixGatetest)
  const autonomy         = useSettings((s) => s.autonomy)
  const defaultModel     = useSettings((s) => s.defaultModel)
  const selfRepairRepo   = useSettings((s) => s.selfRepairRepo)
  const selfRepairBranch = useSettings((s) => s.selfRepairBranch)
  const setSelfRepairRepo   = useSettings((s) => s.setSelfRepairRepo)
  const setSelfRepairBranch = useSettings((s) => s.setSelfRepairBranch)
  const setAnthropic  = useSettings((s) => s.setAnthropicKey)
  const setGhToken    = useSettings((s) => s.setGithubToken)
  const setGhOrg      = useSettings((s) => s.setGithubOrg)
  const setGatetest   = useSettings((s) => s.setGatetestKey)
  const setAutoFix    = useSettings((s) => s.setAutoFixGatetest)
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
          <h3 className="hm-drawer-section-title">Code-host PAT (GitHub or GlueCron)</h3>
          <p className="hm-drawer-help">
            Personal access token for whichever code host you're using.
            Lets the Console read + write your repos.
            <br />
            <strong>GitHub</strong>: <code>github_pat_…</code> with <code>repo</code> scope —{' '}
            <a href="https://github.com/settings/tokens" target="_blank" rel="noreferrer">
              github.com/settings/tokens
            </a>.
            <br />
            <strong>GlueCron</strong>: <code>glc_…</code> from{' '}
            <a href="https://gluecron.com/settings/tokens" target="_blank" rel="noreferrer">
              gluecron.com/settings/tokens
            </a>.
            <br />
            Holden Mercer auto-detects which host based on the backend's <code>CODE_HOST</code> env.
          </p>
          <input
            className="hm-input"
            type="password"
            value={githubToken}
            onChange={(e) => setGhToken(e.target.value)}
            placeholder="github_pat_… or glc_…"
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
            placeholder="Username or org (e.g. ccantynz-alt)"
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
          <h3 className="hm-drawer-section-title">gatetest.ai</h3>
          <p className="hm-drawer-help">
            API key for{' '}
            <a href="https://www.gatetest.ai/" target="_blank" rel="noreferrer">gatetest.ai</a>
            {' '}— your own scanner running 90 modules across security, docs,
            compatibility, SEO. With this set, the Gate tab gets a{' '}
            <strong>Run gatetest.ai scan</strong> button alongside the GHA gate.
            Format: <code>gt_live_…</code>. Email{' '}
            <a href="mailto:hello@gatetest.ai">hello@gatetest.ai</a> to get a key.
          </p>
          <input
            className="hm-input"
            type="password"
            value={gatetestKey}
            onChange={(e) => setGatetest(e.target.value)}
            placeholder="gt_live_…"
            autoComplete="off"
            spellCheck={false}
          />
          {gatetestKey && (
            <p className="hm-drawer-confirm">Saved: <code>{mask(gatetestKey)}</code></p>
          )}

          <div style={{ marginTop: 12, padding: 8, background: 'rgba(255,255,255,0.03)', borderRadius: 6, fontSize: 12 }}>
            <div style={{ marginBottom: 6, color: 'var(--text-muted)' }}>
              <strong>Webhook URL</strong> — paste this into gatetest.ai's
              project webhook config so scan results push to HM automatically:
            </div>
            <code style={{ display: 'block', padding: 6, background: 'var(--bg, #0a0a0b)', borderRadius: 4, wordBreak: 'break-all' }}>
              https://www.holdenmercer.com/api/gatetest/webhook
            </code>
            <div style={{ marginTop: 6, color: 'var(--text-muted)', fontSize: 11 }}>
              When gatetest.ai posts here, HM stores the result in
              <code> .holdenmercer/gatetest-latest.json</code> in the target
              repo + the dashboard auto-refreshes the Gate panel.
            </div>
          </div>

          <label className="hm-radio" style={{ marginTop: 12 }}>
            <input
              type="checkbox"
              checked={autoFixGatetest}
              onChange={(e) => setAutoFix(e.target.checked)}
            />
            <span>
              <strong>Auto-fix on failed scans</strong>
              <span className="hm-radio-help">
                When a gatetest.ai scan returns failures, automatically dispatch
                a self-repair task (same as clicking "Auto-fix all" manually).
                Branch + PR + gate-protected merge — never lands on main without
                a green gate.
              </span>
            </span>
          </label>
        </section>

        <section className="hm-drawer-section">
          <h3 className="hm-drawer-section-title">Self-repair</h3>
          <p className="hm-drawer-help">
            Holden Mercer can read + edit its OWN code. Point this at the repo
            that hosts this dashboard, and the <strong>🔧 Fix this</strong> button
            in the header — plus the error-boundary "Send to Claude" path on
            crashes — will dispatch background tasks against it.
            <br /><br />
            Default: <code>ccantynz-alt/HoldenMercer.com</code>. Change if you've
            forked or self-host.
          </p>
          <input
            className="hm-input"
            type="text"
            value={selfRepairRepo}
            onChange={(e) => setSelfRepairRepo(e.target.value)}
            placeholder="ccantynz-alt/HoldenMercer.com"
            spellCheck={false}
          />
          <input
            className="hm-input"
            type="text"
            value={selfRepairBranch}
            onChange={(e) => setSelfRepairBranch(e.target.value)}
            placeholder="(default branch — leave empty unless you target a fork branch)"
            spellCheck={false}
            style={{ marginTop: 8 }}
          />
          {selfRepairRepo ? (
            <p className="hm-drawer-confirm">
              Self-repair targets: <code>{selfRepairRepo}</code>
              {selfRepairBranch ? <> @ <code>{selfRepairBranch}</code></> : null}
            </p>
          ) : (
            <p className="hm-drawer-confirm" style={{ color: 'var(--text-muted)' }}>
              Using default: <code>ccantynz-alt/HoldenMercer.com</code>{' '}
              <span style={{ fontSize: 12 }}>
                — the grey placeholder above is just a hint; the default is already active.
              </span>
            </p>
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
