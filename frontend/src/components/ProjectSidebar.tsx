/**
 * ProjectSidebar — list of projects + new-project button.
 *
 * Selecting a project sets it as active in the projects store, which the
 * App shell uses to decide what to render in the main pane. On mobile the
 * sidebar slides in from the left when `isOpen` is true.
 */

import { useProjects } from '../stores/projects'

interface Props {
  onNewProject:   () => void
  isOpen?:        boolean
  onPickProject?: () => void
}

export function ProjectSidebar({ onNewProject, isOpen, onPickProject }: Props) {
  const projects        = useProjects((s) => s.projects)
  const activeProjectId = useProjects((s) => s.activeProjectId)
  const setActive       = useProjects((s) => s.setActive)

  const pick = (id: string) => {
    setActive(id)
    onPickProject?.()
  }

  return (
    <aside className={`hm-sidebar${isOpen ? ' is-open' : ''}`}>
      <div className="hm-sidebar-header">
        <span className="hm-sidebar-title">Projects</span>
        <button
          className="hm-icon-btn"
          onClick={onNewProject}
          title="New project"
          aria-label="New project"
        >
          +
        </button>
      </div>

      {projects.length === 0 ? (
        <div className="hm-sidebar-empty">
          No projects yet.
          <br />
          <button className="hm-link-btn" onClick={onNewProject}>
            Create your first
          </button>
        </div>
      ) : (
        <ul className="hm-project-list">
          {projects.map((p) => (
            <li key={p.id}>
              <button
                className={`hm-project-item${
                  p.id === activeProjectId ? ' is-active' : ''
                }`}
                onClick={() => pick(p.id)}
              >
                <span className="hm-project-name">{p.name}</span>
                <span className={`hm-project-status hm-status-${p.status}`}>
                  {p.status}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  )
}
