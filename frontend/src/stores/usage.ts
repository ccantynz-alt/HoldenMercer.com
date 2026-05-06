/**
 * Usage store — tracks Anthropic API token spend per day.
 *
 * Console.tsx feeds this from the `usage` SSE event after each turn.
 * AdminHome surfaces today + 7-day totals + estimated $ so you can see
 * what's eating your key before the bill arrives.
 *
 * Persisted to localStorage. 30-day rolling window — older buckets get pruned.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface UsageRecord {
  model:                       string
  input_tokens:                number
  output_tokens:               number
  cache_read_input_tokens:     number
  cache_creation_input_tokens: number
}

interface DayBucket {
  /** YYYY-MM-DD in local time. */
  date:    string
  /** Per-model totals so we can price accurately. */
  byModel: Record<string, UsageRecord>
}

interface UsageState {
  days: DayBucket[]
  record: (r: UsageRecord) => void
  clear:  () => void
}

/** Anthropic public list pricing as of 2026-05. $/MTok.
 *  Cache read is ~10% of input, cache write ~25% over input.
 *  Update if Anthropic re-prices. */
const PRICING: Record<string, {
  input: number; output: number; cache_read: number; cache_write: number
}> = {
  'claude-opus-4-7':           { input: 15,  output: 75,  cache_read: 1.5,  cache_write: 18.75 },
  'claude-sonnet-4-6':         { input: 3,   output: 15,  cache_read: 0.3,  cache_write: 3.75 },
  'claude-haiku-4-5-20251001': { input: 1,   output: 5,   cache_read: 0.1,  cache_write: 1.25 },
}

const FALLBACK_PRICE = PRICING['claude-sonnet-4-6']

export function priceFor(r: UsageRecord): number {
  const p = PRICING[r.model] ?? FALLBACK_PRICE
  return (
    (r.input_tokens                * p.input       +
     r.output_tokens               * p.output      +
     r.cache_read_input_tokens     * p.cache_read  +
     r.cache_creation_input_tokens * p.cache_write) / 1_000_000
  )
}

function todayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function emptyRecord(model: string): UsageRecord {
  return {
    model,
    input_tokens:                0,
    output_tokens:               0,
    cache_read_input_tokens:     0,
    cache_creation_input_tokens: 0,
  }
}

export const useUsage = create<UsageState>()(
  persist(
    (set) => ({
      days: [],
      record: (r) => set((state) => {
        const date = todayKey()
        const days = [...state.days]
        let bucket = days.find((d) => d.date === date)
        if (!bucket) {
          bucket = { date, byModel: {} }
          days.push(bucket)
        }
        const cur = bucket.byModel[r.model] ?? emptyRecord(r.model)
        bucket.byModel[r.model] = {
          model:                       r.model,
          input_tokens:                cur.input_tokens                + r.input_tokens,
          output_tokens:               cur.output_tokens               + r.output_tokens,
          cache_read_input_tokens:     cur.cache_read_input_tokens     + r.cache_read_input_tokens,
          cache_creation_input_tokens: cur.cache_creation_input_tokens + r.cache_creation_input_tokens,
        }
        // Prune to 30 days
        const cutoff = new Date()
        cutoff.setDate(cutoff.getDate() - 30)
        const cutoffKey = cutoff.toISOString().slice(0, 10)
        return { days: days.filter((d) => d.date >= cutoffKey) }
      }),
      clear: () => set({ days: [] }),
    }),
    { name: 'holdenmercer:usage:v1' }
  )
)

/** Aggregate over a window. days=1 → today, days=7 → last 7 days. */
export function summarise(days: DayBucket[], windowDays: number): {
  totalDollars: number
  totalTokens:  number
  byModel:      Record<string, { tokens: number; dollars: number }>
} {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - (windowDays - 1))
  cutoff.setHours(0, 0, 0, 0)
  const cutoffKey = cutoff.toISOString().slice(0, 10)

  let totalDollars = 0
  let totalTokens  = 0
  const byModel: Record<string, { tokens: number; dollars: number }> = {}

  for (const d of days) {
    if (d.date < cutoffKey) continue
    for (const r of Object.values(d.byModel)) {
      const tokens  = r.input_tokens + r.output_tokens + r.cache_read_input_tokens + r.cache_creation_input_tokens
      const dollars = priceFor(r)
      totalTokens  += tokens
      totalDollars += dollars
      const cur = byModel[r.model] ?? { tokens: 0, dollars: 0 }
      cur.tokens  += tokens
      cur.dollars += dollars
      byModel[r.model] = cur
    }
  }
  return { totalDollars, totalTokens, byModel }
}
