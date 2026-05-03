/**
 * ProjectShell — main pane when a project is selected. Holds the per-project
 * tab strip + repo-link control and routes to the active tab.
 */

import { useState } from 'react'
import { useProjects } from '../stores/projects'
import { Brief } from './Brief'
import { Console } from './Console'
import { Memory } from './Memory'
import { TaskSwarm } from './TaskSwarm'
import { LinkRepoModal } from './LinkRepoModal'

type TabId = 'brief' | 'console' | 'swarm' | 'memory' | 'deploy'

const TABS: { id: TabId; label: string }[] = [
  { id: 'brief',   label: 'Brief'   },
  { id: 'console', label: 'Console' },
  { id: 'memory',  label: 'Memory'  },
  { id: 'swarm',   label: 'Swarm'   },
  { id: 'deploy',  label: 'Deploy'  },
]

export function ProjectShell() {
  const project = useProjects((s) =>
    s.projects.find((p) => p.id === s.activeProjectId) ?? null
  )
  const [tab, setTab]               = useState<TabId>('brief')
  const [linkOpen, setLinkOpen]     = useState(false)

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
          <button
            className="hm-repo-link"
            onClick={() => setLinkOpen(true)}
            title={project.repo ? 'Repo linked — click to change' : 'Link to a GitHub repo'}
          >
            {project.repo
              ? <>📦 <code>{project.repo}</code> · <span className="hm-repo-branch">{project.branch || 'main'}</span></>
              : <>+ Link a GitHub repo</>}
          </button>
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
        {tab === 'brief'    ? <Brief    projectId={project.id} />
         : tab === 'console' ? <Console projectId={project.id} />
         : tab === 'memory'  ? <Memory  projectId={project.id} />
         : tab === 'swarm'   ? <TaskSwarm />
         : <Placeholder tab={tab} />}
      </div>

      <LinkRepoModal
        projectId={project.id}
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
      />
    </section>
  )
}

function Placeholder({ tab }: { tab: TabId }) {
  const messages: Record<TabId, { title: string; body: string }> = {
    brief:   { title: '', body: '' },
    console: { title: '', body: '' },
    memory:  { title: '', body: '' },
    swarm:   { title: '', body: '' },
    deploy:  {
      title: 'Deploy — landing in PR D.',
      body:  'CronTech deploy controls + preview URL. The Programmatic Gate (lint + typecheck + tests) runs here; failures auto-repair via the Shadow Architect loop.',
    },
  }
  const { title, body } = messages[tab]
  if (!title) return null
  return (
    <div className="hm-placeholder">
      <h2 className="hm-placeholder-title">{title}</h2>
      <p className="hm-placeholder-body">{body}</p>
    </div>
  )
}
