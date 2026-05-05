/**
 * Plans store — per-project drafting surface.
 *
 * Plans are a place to think out loud BEFORE you ship work. You write them
 * (often dictated on iPad), refine them, then click "Send to Console" or
 * "Run in background" — the plan becomes the agent's prompt with no
 * copy-paste in between.
 *
 * Each plan is local-first (persisted to localStorage). PR R will sync them
 * to the linked repo as `.holdenmercer/plans/<slug>.md` so they survive
 * across devices, but the local cache always wins for snappy editing.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type PlanStatus = 'draft' | 'ready' | 'shipped' | 'archived'

export interface Plan {
  id:        string
  projectId: string
  title:     string
  body:      string
  status:    PlanStatus
  createdAt: number
  updatedAt: number
}

interface PlansState {
  plans: Plan[]
  /** projectId → planId of the active plan in that project's Planner tab. */
  activeByProject: Record<string, string>
  setActive:    (projectId: string, planId: string | null) => void
  list:         (projectId: string) => Plan[]
  get:          (id: string) => Plan | undefined
  create:       (projectId: string, seed?: { title?: string; body?: string }) => Plan
  update:       (id: string, patch: Partial<Pick<Plan, 'title' | 'body' | 'status'>>) => void
  remove:       (id: string) => void
}

function newPlanId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

export const usePlans = create<PlansState>()(
  persist(
    (set, get) => ({
      plans: [],
      activeByProject: {},

      setActive: (projectId, planId) => set((s) => ({
        activeByProject: planId === null
          ? Object.fromEntries(Object.entries(s.activeByProject).filter(([k]) => k !== projectId))
          : { ...s.activeByProject, [projectId]: planId },
      })),

      list: (projectId) =>
        get().plans
          .filter((p) => p.projectId === projectId)
          .sort((a, b) => b.updatedAt - a.updatedAt),

      get: (id) => get().plans.find((p) => p.id === id),

      create: (projectId, seed) => {
        const now = Date.now()
        const plan: Plan = {
          id:        newPlanId(),
          projectId,
          title:     (seed?.title ?? '').trim() || 'Untitled plan',
          body:      seed?.body ?? '',
          status:    'draft',
          createdAt: now,
          updatedAt: now,
        }
        set((s) => ({
          plans:           [plan, ...s.plans],
          activeByProject: { ...s.activeByProject, [projectId]: plan.id },
        }))
        return plan
      },

      update: (id, patch) => set((s) => ({
        plans: s.plans.map((p) =>
          p.id === id ? { ...p, ...patch, updatedAt: Date.now() } : p
        ),
      })),

      remove: (id) => set((s) => {
        const plan = s.plans.find((p) => p.id === id)
        const nextActive = { ...s.activeByProject }
        if (plan && nextActive[plan.projectId] === id) {
          delete nextActive[plan.projectId]
        }
        return {
          plans: s.plans.filter((p) => p.id !== id),
          activeByProject: nextActive,
        }
      }),
    }),
    { name: 'holdenmercer:plans:v1' }
  )
)
