/**
 * ProjectShell — main pane when a project is selected. Holds the per-project
 * tab strip + repo-link control and routes to the active tab.
 */

import { useState } from 'react'
import { useProjects } from '../stores/projects'
import { Brief } from './Brief'
import { Console } from './Console'
import { Memory } from './Memory'
import { Gate } from './Gate'
import { Preview } from './Preview'
import { Tasks } from './Tasks'
import { TaskSwarm } from './TaskSwarm'
import { LinkRepoModal } from './LinkRepoModal'

type TabId = 'brief' | 'console' | 'preview' | 'gate' | 'tasks' | 'memory' | 'swarm'

const TABS: { id: TabId; label: string }[] = [
  { id: 'brief',   label: 'Brief'   },
  { id: 'console', label: 'Console' },
  { id: 'preview', label: 'Preview' },
  { id: 'gate',    label: 'Gate'    },
  { id: 'tasks',   label: 'Tasks'   },
  { id: 'memory',  label: 'Memory'  },
  { id: 'swarm',   label: 'Swarm'   },
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
         : tab === 'preview' ? <Preview projectId={project.id} />
         : tab === 'gate'    ? <Gate    projectId={project.id} onSwitchToConsole={() => setTab('console')} />
         : tab === 'tasks'   ? <Tasks   projectId={project.id} />
         : tab === 'memory'  ? <Memory  projectId={project.id} />
         : <TaskSwarm />}
      </div>

      <LinkRepoModal
        projectId={project.id}
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
      />
    </section>
  )
}
