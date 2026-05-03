/**
 * SettingsPanel — slide-over drawer for user-level config.
 *
 * BYOK Anthropic key, autonomy default, default model. Values live in
 * localStorage via the settings store. PR B will pass the key through to
 * the backend on every Console request (never stored server-side).
 */

import { useSettings, type AutonomyMode } from '../stores/settings'

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
  { value: 'claude-opus-4-7',          label: 'Opus 4.7 — most capable' },
  { value: 'claude-sonnet-4-6',        label: 'Sonnet 4.6 — balanced' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 — fast / cheap' },
]

export function SettingsPanel({ open, onClose }: Props) {
  const anthropicKey  = useSettings((s) => s.anthropicKey)
  const autonomy      = useSettings((s) => s.autonomy)
  const defaultModel  = useSettings((s) => s.defaultModel)
  const setKey        = useSettings((s) => s.setAnthropicKey)
  const setAutonomy   = useSettings((s) => s.setAutonomy)
  const setModel      = useSettings((s) => s.setDefaultModel)

  if (!open) return null

  const masked = anthropicKey
    ? `${anthropicKey.slice(0, 8)}…${anthropicKey.slice(-4)}`
    : ''

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
            to the backend on each request, never persisted server-side.
          </p>
          <input
            className="hm-input"
            type="password"
            value={anthropicKey}
            onChange={(e) => setKey(e.target.value)}
            placeholder="sk-ant-…"
            autoComplete="off"
            spellCheck={false}
          />
          {masked && (
            <p className="hm-drawer-confirm">
              Saved: <code>{masked}</code>
            </p>
          )}
        </section>

        <section className="hm-drawer-section">
          <h3 className="hm-drawer-section-title">Default autonomy</h3>
          <p className="hm-drawer-help">
            How aggressive the Console runs. Per-project override coming next.
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
      </div>
    </div>
  )
}
