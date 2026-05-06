/**
 * Dispatch guard — single source of truth for "can we fire a background
 * task right now?". Every UI surface that calls dispatchTask should run
 * this first.
 *
 * Returns null when safe; an error message when blocked.
 *
 * Reasons we block:
 *   1. User flipped the master 🛑 PAUSE ALL DISPATCHES toggle
 *   2. Today's cumulative API spend already exceeds the user's daily cap
 *   3. The estimated cost of THIS dispatch would push today's total over cap
 *
 * Surface this via toast() — always show ALL THREE reasons at once if
 * multiple apply, so the user can act decisively.
 */

import { useSettings } from '../stores/settings'
import { useUsage, summarise, estimateTaskCost } from '../stores/usage'

export interface DispatchPlan {
  model:    string
  maxIters: number
  /** Force Haiku regardless of user's defaultModel. Used for the auto-fix
   *  flows where we want predictable cost. */
  forceHaiku?: boolean
}

const HAIKU = 'claude-haiku-4-5-20251001'

/** Returns a string when blocked (display via toast); null when safe to fire. */
export function checkDispatch(plan: DispatchPlan): string | null {
  const s = useSettings.getState()

  if (s.pauseAutoDispatch) {
    return (
      'All dispatches PAUSED. Open Settings → 🛑 Pause toggle and turn it off ' +
      'when you want to resume. (Set to protect your API key from runaway spend.)'
    )
  }

  const cap = s.dailyCostCapUsd
  if (cap > 0) {
    const days  = useUsage.getState().days
    const today = summarise(days, 1).totalDollars
    const model = plan.forceHaiku ? HAIKU : (plan.model || HAIKU)
    const fc    = estimateTaskCost(model, plan.maxIters).estimatedDollars
    if (today >= cap) {
      return (
        `Daily cost cap hit ($${today.toFixed(2)} of $${cap.toFixed(2)} today). ` +
        `Dispatch refused. Raise the cap in Settings, wait until tomorrow's reset, ` +
        `or pause-then-investigate.`
      )
    }
    if (today + fc > cap) {
      return (
        `This dispatch would exceed your daily cap. ` +
        `Today: $${today.toFixed(2)} · this task forecast: $${fc.toFixed(3)} · cap: $${cap.toFixed(2)}. ` +
        `Lower max_iters, switch to Haiku, raise the cap, or wait until tomorrow.`
      )
    }
  }

  return null
}

/** The model that should actually be dispatched, given the plan + settings.
 *  Use this in lieu of reading settings.defaultModel directly so we
 *  consistently respect forceHaiku. */
export function effectiveDispatchModel(plan: DispatchPlan): string {
  if (plan.forceHaiku) return HAIKU
  return plan.model || useSettings.getState().defaultModel || HAIKU
}
