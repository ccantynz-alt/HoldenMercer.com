/**
 * Projects store — list of builder projects + active selection.
 *
 * Persisted to localStorage so projects survive a refresh. Each project is
 * a unit of work the user is building (a website, an app, a tool). PR B
 * will back each project with a GitHub repo via GlueCron; for now the
 * project is local-only metadata.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ProjectStatus = 'idle' | 'building' | 'gate-failing' | 'shipped'

export interface Project {
  id:           string
  name:         string
  description:  string
  /** Optional GitHub repo in 'owner/name' form, once linked. */
  repo:         string | null
  /** Default branch to commit to. Inherited from the repo, or 'main'. */
  branch:       string | null
  status:       ProjectStatus
  createdAt:    number
  lastOpenedAt: number
}

interface ProjectsState {
  projects:        Project[]
  activeProjectId: string | null
  setActive:       (id: string | null) => void
  create:          (input: { name: string; description: string }) => Project
  update:          (id: string, patch: Partial<Project>) => void
  remove:          (id: string) => void
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'project'
}

function uniqueId(name: string, taken: Set<string>): string {
  const base = slug(name)
  if (!taken.has(base)) return base
  let i = 2
  while (taken.has(`${base}-${i}`)) i++
  return `${base}-${i}`
}

export const useProjects = create<ProjectsState>()(
  persist(
    (set, get) => ({
      projects:        [],
      activeProjectId: null,

      setActive: (id) => set((s) => {
        if (id === null) return { activeProjectId: null }
        const project = s.projects.find((p) => p.id === id)
        if (!project) return s
        return {
          activeProjectId: id,
          projects: s.projects.map((p) =>
            p.id === id ? { ...p, lastOpenedAt: Date.now() } : p
          ),
        }
      }),

      create: ({ name, description }) => {
        const taken = new Set(get().projects.map((p) => p.id))
        const now   = Date.now()
        const project: Project = {
          id:           uniqueId(name, taken),
          name:         name.trim() || 'Untitled',
          description:  description.trim(),
          repo:         null,
          branch:       null,
          status:       'idle',
          createdAt:    now,
          lastOpenedAt: now,
        }
        set((s) => ({
          projects:        [project, ...s.projects],
          activeProjectId: project.id,
        }))
        return project
      },

      update: (id, patch) => set((s) => ({
        projects: s.projects.map((p) => (p.id === id ? { ...p, ...patch } : p)),
      })),

      remove: (id) => set((s) => ({
        projects:        s.projects.filter((p) => p.id !== id),
        activeProjectId: s.activeProjectId === id ? null : s.activeProjectId,
      })),
    }),
    { name: 'holdenmercer:projects:v1' }
  )
)
