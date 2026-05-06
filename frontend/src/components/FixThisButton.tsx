/**
 * FixThisButton — header-mounted "🔧 Fix this" surface.
 *
 * Clicking it opens a small dialog. The user describes what's broken
 * (or what they want changed) about the dashboard itself. On submit, a
 * background task is dispatched against the configured self-repair
 * repo (the Holden Mercer repo itself, by default).
 *
 * The agent runs the same flywheel-first / branch-and-PR / gate-protected
 * doctrine as any other task — so a self-repair attempt that breaks
 * something can't merge to main. The user reviews the PR before it
 * deploys.
 *
 * If the self-repair repo isn't configured, the button shows a quick
 * setup state pointing at Settings.
 */

import { useEffect, useRef, useState } from 'react'
import { useSettings } from '../stores/settings'
import { dispatchTask } from '../lib/jobs'

interface Props {
  /** Optional pre-filled context (e.g. captured error text from ErrorBoundary). */
  prefill?: string
  /** Called after successful dispatch so caller can navigate to Tasks. */
  onDispatched?: (task_id: string) => void
}

const WrenchIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.121 2.121 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
  </svg>
)

export function FixThisButton({ prefill, onDispatched }: Props) {
  const repo   = useSettings((s) => s.selfRepairRepo)
  const branch = useSettings((s) => s.selfRepairBranch)

  const [open, setOpen]       = useState(false)
  const [request, setRequest] = useState('')
  const [includeUrl, setIncludeUrl] = useState(true)
  const [busy, setBusy]       = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const taRef = useRef<HTMLTextAreaElement | null>(null)

  // Open with prefilled context (e.g. from an error boundary)
  useEffect(() => {
    if (prefill && !open) {
      setRequest(prefill)
      setOpen(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill])

  useEffect(() => {
    if (open) setTimeout(() => taRef.current?.focus(), 50)
  }, [open])

  const submit = async () => {
    const description = request.trim()
    if (!description || busy) return
    if (!repo) {
      setError('Self-repair repo not configured. Open Settings → Self-repair.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const ctx: string[] = []
      if (includeUrl && typeof window !== 'undefined') {
        ctx.push(`Page: ${window.location.href}`)
        ctx.push(`User-Agent: ${navigator.userAgent}`)
        ctx.push(`Viewport: ${window.innerWidth}×${window.innerHeight}`)
      }
      const prompt = SELF_REPAIR_PROMPT(description, ctx)

      const dispatched = await dispatchTask({
        repo,
        prompt,
        brief:  'Self-repair task — Claude is editing the Holden Mercer dashboard itself.',
        branch: branch || undefined,
        max_iters: 40,
      })

      onDispatched?.(dispatched.task_id)
      setOpen(false)
      setRequest('')
      const installedNote = dispatched.auto_installed
        ? `\n\nFirst-time setup done — installed the task workflow + agent runner ` +
          `in this repo. One more step (one-time per repo): add your Anthropic ` +
          `API key as a repo secret called ANTHROPIC_API_KEY:\n${dispatched.secret_setup_url}`
        : ''
      alert(
        `Self-repair task dispatched (${dispatched.task_id}).\n\n` +
        `Claude will work on a branch (claude/fix-…), open a PR, and the gate ` +
        `must go green before merge. Check Tasks tab for progress; once it ` +
        `merges + Vercel redeploys, the fix is live.${installedNote}`
      )
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        className="hm-icon-btn hm-fix-btn"
        onClick={() => setOpen(true)}
        aria-label="Fix this"
        title="🔧 Fix the dashboard itself — dispatches a self-repair task"
      >
        <WrenchIcon />
      </button>

      {open && (
        <div className="hm-modal-backdrop" onClick={() => !busy && setOpen(false)}>
          <div className="hm-modal hm-fix-modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="hm-modal-title">🔧 Fix the dashboard</h2>
            <p className="hm-modal-lede">
              Claude reads + edits Holden Mercer's own code, opens a PR, runs the
              gate, merges only if green. Describe what's broken or what should
              change — be specific (which page, what behaviour, what should happen
              instead).
            </p>

            {!repo && (
              <div className="hm-link-error">
                Self-repair repo not configured. Open Settings → <strong>Self-repair</strong>{' '}
                and point it at <code>ccantynz-alt/HoldenMercer.com</code> first.
              </div>
            )}

            <label className="hm-field">
              <span className="hm-field-label">What's wrong / what to change</span>
              <textarea
                ref={taRef}
                className="hm-textarea"
                value={request}
                onChange={(e) => setRequest(e.target.value)}
                placeholder={`e.g. "the Settings drawer doesn't save my code-host PAT — it forgets it on reload"\n\nor: "add a 'duplicate project' button on AdminHome project cards"\n\nDescribe what's broken or what should change. Specific = good.`}
                rows={7}
                autoCapitalize="sentences"
                autoCorrect="on"
                spellCheck
              />
            </label>

            <label className="hm-radio" style={{ marginTop: 4 }}>
              <input
                type="checkbox"
                checked={includeUrl}
                onChange={(e) => setIncludeUrl(e.target.checked)}
              />
              <span>
                <strong>Include current page URL + browser info</strong>
                <span className="hm-radio-help">
                  Helps Claude target the right component. Disable if you're
                  describing something architectural.
                </span>
              </span>
            </label>

            {error && <div className="hm-link-error">{error}</div>}

            <div className="hm-modal-actions">
              <button
                type="button"
                className="hm-btn-ghost"
                onClick={() => setOpen(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="hm-btn-primary"
                onClick={submit}
                disabled={busy || !request.trim() || !repo}
              >
                {busy ? 'Dispatching…' : 'Dispatch self-repair →'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function SELF_REPAIR_PROMPT(description: string, context: string[]): string {
  const ctxBlock = context.length
    ? `\nContext from the user's browser:\n  ${context.join('\n  ')}`
    : ''
  return `Self-repair task — you are editing the Holden Mercer dashboard ITSELF.

The user filed this from inside the dashboard:

  ${description.replace(/\n/g, '\n  ')}
${ctxBlock}

DOCTRINE (binding):
  • Branch + PR + gate-protected merge — never commit to main directly
  • Read flywheel context FIRST (check_recent_activity)
  • claim_work BEFORE editing
  • Keep your scope tight — fix ONLY what the user asked about, no
    drive-by refactors. If you spot something else worth fixing, note
    it in the PR body but DO NOT touch it in this PR.
  • Maintain ALL invariants in .holdenmercer/invariants.md if present
  • Run the gate before opening the PR; if it fails, fix on the branch
    + run again. merge_pull_request will refuse a red gate anyway.

Stack reminders for this repo:
  • Frontend: Vite + React + TS in frontend/src
  • Backend:  FastAPI in api/, tests in tests/
  • Build:    cd frontend && npm install && npm run build
  • Tests:    pytest in repo root
  • Gate workflow:  .github/workflows/holden-mercer-gate.yml
  • Vercel auto-deploys on push to main

When done: report_result with a one-paragraph summary + the PR URL.`
}
