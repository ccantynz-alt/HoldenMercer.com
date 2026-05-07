/**
 * BlockLibraryModal — Layer 3 visual builder picker.
 *
 * Click "+ Add block" on the Edit panel → modal opens with categorized
 * block tiles. Click a tile → confirm dialog with target hint → dispatches
 * a tightly-scoped task that adapts the block to the project's tech
 * stack, opens a PR, doesn't auto-merge.
 *
 * Doesn't try to be a designer. Doesn't try to do drag-and-drop. Just
 * a "what shape do you want, AI handles the rest" picker.
 */

import { useState } from 'react'
import { BLOCK_LIBRARY, addBlockPrompt, type Block, type BlockCategory } from '../data/blocks'
import { dispatchTask } from '../lib/jobs'
import { useSettings } from '../stores/settings'
import { toast } from '../stores/toast'
import { checkDispatch, effectiveDispatchModel } from '../lib/dispatchGuard'

interface Props {
  open: boolean
  onClose: () => void
  repo:   string
  onDispatched?: (taskId: string, block: Block) => void
}

const CATEGORY_LABEL: Record<BlockCategory, string> = {
  hero:        'Heroes',
  feature:     'Features',
  gallery:     'Galleries',
  form:        'Forms',
  pricing:     'Pricing',
  testimonial: 'Testimonials',
  faq:         'FAQ',
  cta:         'CTAs',
  footer:      'Footers',
}

const CATEGORY_ORDER: BlockCategory[] = [
  'hero', 'feature', 'gallery', 'form', 'pricing', 'testimonial', 'faq', 'cta', 'footer',
]

export function BlockLibraryModal({ open, onClose, repo, onDispatched }: Props) {
  const [picked, setPicked] = useState<Block | null>(null)
  const [target, setTarget] = useState('')
  const [busy, setBusy]     = useState(false)

  if (!open) return null

  const dispatchAdd = async () => {
    if (!picked || !repo) return
    const plan = { model: '', maxIters: 25, forceHaiku: true }
    const blocked = checkDispatch(plan)
    if (blocked) {
      toast('error', 'Add block blocked', blocked)
      return
    }
    setBusy(true)
    const globalPrefs = useSettings.getState().globalPrefs
    const briefPrefix = globalPrefs.trim()
      ? `User's global preferences (apply to ALL projects):\n${globalPrefs.trim()}\n\n---\n\n`
      : ''
    try {
      const dispatched = await dispatchTask({
        repo,
        prompt:    addBlockPrompt(repo, picked, target.trim()),
        brief:     briefPrefix + `Visual builder — adding "${picked.name}" block to ${repo}.`,
        model:     effectiveDispatchModel(plan),
        max_iters: plan.maxIters,
      })
      onDispatched?.(dispatched.task_id, picked)
      toast('success', `${picked.name} block dispatched`,
        `Task ${dispatched.task_id} — agent will adapt to your stack and open a PR.`)
      setPicked(null)
      setTarget('')
      onClose()
    } catch (err) {
      toast('error', 'Block dispatch failed', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const grouped: Record<string, Block[]> = {}
  for (const b of BLOCK_LIBRARY) {
    if (!grouped[b.category]) grouped[b.category] = []
    grouped[b.category].push(b)
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1050,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: '6vh', paddingBottom: '6vh',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(900px, 94vw)',
          maxHeight: '88vh',
          background: 'var(--bg-elev, #1a1a1a)',
          border: '1px solid var(--border, #2a2a2a)',
          borderRadius: 12,
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <header style={{
          padding: '14px 20px',
          borderBottom: '1px solid var(--border, #2a2a2a)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18 }}>＋ Add a block</h2>
            <p style={{ margin: '4px 0 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
              Pick a structural pattern. The agent adapts it to your project's
              tech stack (React/Vue/Astro/HTML), styling system, and copy from
              your brief. PR opens for your review — never auto-merges.
            </p>
          </div>
          <button
            className="hm-icon-btn"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          >×</button>
        </header>

        {!picked ? (
          <div style={{ padding: 16, overflowY: 'auto' }}>
            {CATEGORY_ORDER.map((cat) => {
              const items = grouped[cat]
              if (!items || items.length === 0) return null
              return (
                <section key={cat} style={{ marginBottom: 18 }}>
                  <h3 style={{
                    fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.06em',
                    color: 'var(--text-muted)', margin: '0 0 8px 4px',
                  }}>
                    {CATEGORY_LABEL[cat]}
                  </h3>
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                    gap: 10,
                  }}>
                    {items.map((b) => (
                      <button
                        key={b.id}
                        onClick={() => setPicked(b)}
                        style={{
                          textAlign: 'left',
                          padding: 12,
                          background: 'rgba(255,255,255,0.03)',
                          border: '1px solid var(--border, #2a2a2a)',
                          borderRadius: 8,
                          cursor: 'pointer',
                          color: 'var(--text)',
                          transition: 'border-color 120ms',
                        }}
                        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'rgba(99,102,241,0.5)' }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border, #2a2a2a)' }}
                      >
                        <div style={{ fontSize: 22, marginBottom: 4 }}>{b.icon}</div>
                        <div style={{ fontWeight: 600, marginBottom: 2 }}>{b.name}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                          {b.description}
                        </div>
                      </button>
                    ))}
                  </div>
                </section>
              )
            })}
          </div>
        ) : (
          <div style={{ padding: 20, overflowY: 'auto' }}>
            <button
              onClick={() => { setPicked(null); setTarget('') }}
              style={{
                background: 'transparent', border: 'none', color: 'var(--text-muted)',
                cursor: 'pointer', fontSize: 12, marginBottom: 12,
              }}
            >
              ← back to library
            </button>
            <div style={{ marginBottom: 12 }}>
              <span style={{ fontSize: 28, marginRight: 8 }}>{picked.icon}</span>
              <strong style={{ fontSize: 18 }}>{picked.name}</strong>
              <p style={{ marginTop: 6, color: 'var(--text-muted)', fontSize: 13 }}>
                {picked.description}
              </p>
            </div>

            <label style={{ display: 'block', marginBottom: 12 }}>
              <span style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
                Where should it go? (optional)
              </span>
              <input
                className="hm-input"
                type="text"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder='e.g. "the homepage hero", "above the contact form on /about"'
                disabled={busy}
              />
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                Leave empty and the agent will pick a sensible spot (usually the
                homepage). You'll review the PR before anything lands.
              </p>
            </label>

            <details style={{ marginBottom: 12 }}>
              <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text-muted)' }}>
                Reference HTML structure (the agent adapts this to your stack)
              </summary>
              <pre style={{
                margin: '8px 0 0 0', padding: 10,
                background: 'var(--bg, #0a0a0b)', color: 'var(--text)',
                fontSize: 11, lineHeight: 1.5,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                borderRadius: 6, overflow: 'auto', maxHeight: 240,
              }}>
                {picked.htmlSnippet}
              </pre>
            </details>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                className="hm-btn-ghost"
                onClick={() => { setPicked(null); setTarget('') }}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                className="hm-btn-primary"
                onClick={dispatchAdd}
                disabled={busy}
              >
                {busy ? 'Dispatching…' : `Add ${picked.name} →`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
