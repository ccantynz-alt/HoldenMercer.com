/**
 * ProjectShell — main pane when a project is selected.
 *
 * Two layouts depending on width:
 *  - Wide (≥1100px) AND a docked pane is set → split layout: active tab on
 *    the left, the docked pane on the right with a resizable separator.
 *    Killer combo = Console (left) + Preview (right) live as Claude commits.
 *  - Otherwise → classic tabs, one pane at a time.
 *
 * The docked pane choice + width persist via the settings store, so a
 * Console/Preview split survives reloads.
 */

import { useEffect, useRef, useState } from 'react'
import { useProjects } from '../stores/projects'
import { useSettings, type DockablePane } from '../stores/settings'
import { Brief } from './Brief'
import { Console } from './Console'
import { Memory } from './Memory'
import { Gate } from './Gate'
import { Preview } from './Preview'
import { Tasks } from './Tasks'
import { TaskSwarm } from './TaskSwarm'
import { LinkRepoModal } from './LinkRepoModal'
import { ResizeHandle } from './ResizeHandle'

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

const WIDE_BREAKPOINT_PX = 1100

function useIsWide(): boolean {
  const [wide, setWide] = useState(() =>
    typeof window === 'undefined' ? true : window.innerWidth >= WIDE_BREAKPOINT_PX
  )
  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= WIDE_BREAKPOINT_PX)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return wide
}

export function ProjectShell() {
  const project = useProjects((s) =>
    s.projects.find((p) => p.id === s.activeProjectId) ?? null
  )
  const [tab, setTab]               = useState<TabId>('brief')
  const [linkOpen, setLinkOpen]     = useState(false)

  const dockedPane     = useSettings((s) => s.dockedPane)
  const dockedWidth    = useSettings((s) => s.dockedWidth)
  const setDockedPane  = useSettings((s) => s.setDockedPane)
  const setDockedWidth = useSettings((s) => s.setDockedWidth)

  const isWide = useIsWide()
  const startWidthRef = useRef(dockedWidth)

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

  // Whether the docked pane is currently rendered.
  // Don't dock the same tab as the active one (would be duplicate).
  const showDocked = isWide && !!dockedPane && dockedPane !== (tab as DockablePane)

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
          {project.repo && (
            <a
              className="hm-repo-link"
              style={{ marginLeft: 8 }}
              href={buildShowcaseSubmitUrl(project.repo, project.name, project.description)}
              target="_blank"
              rel="noreferrer"
              title="Submit this project to the public showcase (opens a GitHub edit-and-PR page on the curated registry)"
            >
              🌐 Submit to showcase ↗
            </a>
          )}
        </div>
        <span className={`hm-status-pill hm-status-${project.status}`}>
          {project.status}
        </span>
      </header>

      <nav className="hm-tabs">
        {TABS.map((t) => {
          const isActive    = tab === t.id
          const canDock     = t.id !== 'console' && isWide
          const isDocked    = dockedPane === t.id
          return (
            <span key={t.id} className="hm-tab-wrap">
              <button
                className={`hm-tab${isActive ? ' is-active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
              {canDock && (
                <button
                  className={`hm-tab-dock${isDocked ? ' is-docked' : ''}`}
                  onClick={() => setDockedPane(isDocked ? null : (t.id as DockablePane))}
                  title={isDocked ? `Undock ${t.label}` : `Dock ${t.label} to right of Console`}
                  aria-label={isDocked ? `Undock ${t.label}` : `Dock ${t.label}`}
                >
                  {isDocked ? '◰' : '◳'}
                </button>
              )}
            </span>
          )
        })}
      </nav>

      <div className={`hm-tab-body${showDocked ? ' hm-tab-body-split' : ''}`}>
        <div className="hm-pane hm-pane-main">
          {renderPane(tab, project.id, () => setTab('console'))}
        </div>

        {showDocked && (
          <>
            <ResizeHandle
              onResize={(dx) => setDockedWidth(startWidthRef.current - dx)}
              onResizeEnd={() => { startWidthRef.current = dockedWidth }}
            />
            <aside
              className="hm-pane hm-pane-docked"
              style={{ width: `${dockedWidth}px` }}
              onPointerDown={() => { startWidthRef.current = dockedWidth }}
            >
              <div className="hm-pane-docked-header">
                <span className="hm-pane-docked-title">
                  {(TABS.find((t) => t.id === dockedPane)?.label) ?? dockedPane}
                </span>
                <button
                  className="hm-icon-btn"
                  onClick={() => setDockedPane(null)}
                  aria-label="Undock"
                  title="Undock"
                >
                  ×
                </button>
              </div>
              <div className="hm-pane-docked-body">
                {renderPane(dockedPane as TabId, project.id, () => setTab('console'))}
              </div>
            </aside>
          </>
        )}
      </div>

      <LinkRepoModal
        projectId={project.id}
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
      />
    </section>
  )
}

function renderPane(tab: TabId, projectId: string, switchToConsole: () => void) {
  return tab === 'brief'    ? <Brief    projectId={projectId} />
       : tab === 'console'  ? <Console  projectId={projectId} />
       : tab === 'preview'  ? <Preview  projectId={projectId} />
       : tab === 'gate'     ? <Gate     projectId={projectId} onSwitchToConsole={switchToConsole} />
       : tab === 'tasks'    ? <Tasks    projectId={projectId} />
       : tab === 'memory'   ? <Memory   projectId={projectId} />
       : <TaskSwarm />
}

/** Build a deep-link to the curated registry edit page on GitHub with the
 *  project pre-filled in the URL. The user clicks "Submit yours", edits the
 *  JSON in GitHub's file editor, and opens a PR — standard curator review. */
function buildShowcaseSubmitUrl(repo: string, name: string, tagline: string): string {
  const [owner, repoName] = repo.split('/')
  const today = new Date().toISOString().slice(0, 10)
  const entry = {
    owner, repo: repoName,
    title:    name,
    tagline:  tagline.slice(0, 200),
    category: 'apps',
    added_at: today,
  }
  const hash = `#submit=${encodeURIComponent(JSON.stringify(entry))}`
  return `https://github.com/ccantynz-alt/HoldenMercer.com/edit/main/frontend/public/public-registry.json${hash}`
}
