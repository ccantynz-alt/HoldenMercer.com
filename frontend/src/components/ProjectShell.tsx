/**
 * ProjectShell — main pane when a project is selected. Holds the per-project
 * tab strip and routes to the active tab.
 *
 * PR A only ships Brief as a real surface. Console / Memory / Deploy / Swarm
 * are placeholders explaining what's landing next so the shape is visible.
 */

import { useState } from 'react'
import { useProjects } from '../stores/projects'
import { Brief } from './Brief'
import { TaskSwarm } from './TaskSwarm'

type TabId = 'brief' | 'console' | 'swarm' | 'memory' | 'deploy'

const TABS: { id: TabId; label: string }[] = [
  { id: 'brief',   label: 'Brief'   },
  { id: 'console', label: 'Console' },
  { id: 'swarm',   label: 'Swarm'   },
  { id: 'memory',  label: 'Memory'  },
  { id: 'deploy',  label: 'Deploy'  },
]

export function ProjectShell() {
  const project = useProjects((s) =>
    s.projects.find((p) => p.id === s.activeProjectId) ?? null
  )
  const [tab, setTab] = useState<TabId>('brief')

  if (!project) {
    return (
      <div className="hm-empty-state">
        <h1 className="hm-empty-title">No project selected.</h1>
        <p className="hm-empty-body">
          Pick one from the sidebar, or create a new one to start building.
        </p>
      </div>
    )
  }

  return (
    <section className="hm-project-shell">
      <header className="hm-project-header">
        <div>
          <h1 className="hm-project-title">{project.name}</h1>
          {project.description && (
            <p className="hm-project-tagline">{project.description}</p>
          )}
        </div>
        <span className={`hm-status-pill hm-status-${project.status}`}>
          {project.status}
        </span>
      </header>

      <nav className="hm-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`hm-tab${tab === t.id ? ' is-active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="hm-tab-body">
        {tab === 'brief'   ? <Brief projectId={project.id} />
         : tab === 'swarm' ? <TaskSwarm />
         : <Placeholder tab={tab} />}
      </div>
    </section>
  )
}

function Placeholder({ tab }: { tab: TabId }) {
  const messages: Record<TabId, { title: string; body: string }> = {
    brief:   { title: '', body: '' },
    console: {
      title: 'Console — landing next.',
      body:  'Opus 4.7 with full tool use (file r/w, bash, search, web fetch, cross-repo read), autonomous with smart pause points, dictation-friendly textarea input, and live SSE stream of every tool call.',
    },
    swarm:   { title: '', body: '' },
    memory:  {
      title: 'Memory — landing in PR C.',
      body:  'GlueCron timeline: every session summary, decision, and commit, indexed and searchable. The repo IS the memory — new sessions resume cold by reading it.',
    },
    deploy:  {
      title: 'Deploy — landing in PR C.',
      body:  'CronTech deploy controls + preview URL. The Programmatic Gate (lint + typecheck + tests) runs here; failures auto-repair via the Shadow Architect loop.',
    },
  }
  const { title, body } = messages[tab]
  return (
    <div className="hm-placeholder">
      <h2 className="hm-placeholder-title">{title}</h2>
      <p className="hm-placeholder-body">{body}</p>
    </div>
  )
}
