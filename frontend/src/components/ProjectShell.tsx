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
import { Planner } from './Planner'
import { Console } from './Console'
import { Memory } from './Memory'
import { Gate } from './Gate'
import { Preview } from './Preview'
import { Tasks } from './Tasks'
import { TaskSwarm } from './TaskSwarm'
import { LinkRepoModal } from './LinkRepoModal'
import { ResizeHandle } from './ResizeHandle'
import { AdminHome } from './AdminHome'
import { AuditLog } from './AuditLog'
import { ProjectReadiness } from './ProjectReadiness'
import { SectionErrorBoundary } from './SectionErrorBoundary'
import { dispatchTask } from '../lib/jobs'

type TabId = 'brief' | 'planner' | 'console' | 'preview' | 'gate' | 'tasks' | 'memory' | 'swarm'

const TABS: { id: TabId; label: string }[] = [
  { id: 'brief',   label: 'Brief'   },
  { id: 'planner', label: 'Planner' },
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

interface ProjectShellProps {
  onNewProject?:   () => void
  onOpenSettings?: () => void
}

export function ProjectShell({ onNewProject, onOpenSettings }: ProjectShellProps = {}) {
  const project   = useProjects((s) =>
    s.projects.find((p) => p.id === s.activeProjectId) ?? null
  )
  const setActive = useProjects((s) => s.setActive)
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
      <SystemHome
        onNewProject={() => onNewProject?.()}
        onOpenProject={(id) => setActive(id)}
        onOpenSettings={() => onOpenSettings?.()}
      />
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
            title={project.repo ? 'Repo linked — click to change' : 'Link to a repo'}
          >
            {project.repo
              ? <>📦 <code>{project.repo}</code> · <span className="hm-repo-branch">{project.branch || 'main'}</span></>
              : <>+ Link a repo</>}
          </button>
          {project.repo && (
            <button
              className="hm-repo-link"
              style={{ marginLeft: 8 }}
              onClick={() => onboardProject(project.repo!, project.name, project.branch ?? undefined)}
              title="Scan this existing repo (from Cursor, Bolt, Lovable, hand-coded — anything) and auto-write the brief, invariants, and gate workflow. Runs as a background task."
            >
              🪄 Onboard with Holden Mercer
            </button>
          )}
        </div>
        <span className={`hm-status-pill hm-status-${project.status}`}>
          {project.status}
        </span>
      </header>

      <SectionErrorBoundary name="Project readiness">
        <ProjectReadiness
          projectId={project.id}
          onJumpToTab={(t) => setTab(t)}
        />
      </SectionErrorBoundary>

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
       : tab === 'planner'  ? <Planner  projectId={projectId} onSwitchToConsole={switchToConsole} />
       : tab === 'console'  ? <Console  projectId={projectId} />
       : tab === 'preview'  ? <Preview  projectId={projectId} />
       : tab === 'gate'     ? <Gate     projectId={projectId} onSwitchToConsole={switchToConsole} />
       : tab === 'tasks'    ? <Tasks    projectId={projectId} />
       : tab === 'memory'   ? <Memory   projectId={projectId} />
       : <TaskSwarm />
}

/**
 * SystemHome — wraps AdminHome + AuditLog with a top-level toggle. Shown
 * when no project is selected. This is the operator's "command center"
 * view; per-project work happens after picking a project from the sidebar.
 */
type SystemTab = 'home' | 'audit'

function SystemHome({
  onNewProject, onOpenProject, onOpenSettings,
}: {
  onNewProject: () => void
  onOpenProject: (id: string) => void
  onOpenSettings: () => void
}) {
  const [tab, setTab] = useState<SystemTab>('home')
  return (
    <div>
      <nav className="hm-tabs" style={{ marginBottom: 0, borderBottom: '1px solid var(--border, #2a2a2a)' }}>
        <button
          className={`hm-tab${tab === 'home' ? ' is-active' : ''}`}
          onClick={() => setTab('home')}
        >
          Home
        </button>
        <button
          className={`hm-tab${tab === 'audit' ? ' is-active' : ''}`}
          onClick={() => setTab('audit')}
        >
          Audit log
        </button>
      </nav>
      {tab === 'home' ? (
        <SectionErrorBoundary name="Home">
          <AdminHome
            onNewProject={onNewProject}
            onOpenProject={onOpenProject}
            onOpenSettings={onOpenSettings}
          />
        </SectionErrorBoundary>
      ) : (
        <SectionErrorBoundary name="Audit log">
          <AuditLog />
        </SectionErrorBoundary>
      )}
    </div>
  )
}

async function onboardProject(repo: string, name: string, branch?: string) {
  const ok = confirm(
    `Onboard "${repo}" into Holden Mercer?\n\n` +
    `A background task will scan the repo, auto-write .holdenmercer/brief.md and ` +
    `invariants.md, install the gate workflow, and run the gate once to confirm. ` +
    `It opens a PR you can review before anything lands on main.\n\n` +
    `Watch progress in the Tasks tab.`
  )
  if (!ok) return
  try {
    const dispatched = await dispatchTask({
      repo,
      prompt: ONBOARDING_PROMPT(name, repo),
      brief:  `Onboarding pass for ${name} — auto-written by Holden Mercer.`,
      branch,
      max_iters: 40,
    })
    const installedNote = dispatched.auto_installed
      ? `\n\nFirst-time setup done — installed the task workflow + agent runner.\n` +
        `One more step (one-time per repo): add your Anthropic API key as a repo ` +
        `secret called ANTHROPIC_API_KEY:\n${dispatched.secret_setup_url}\n` +
        `The task will fail without it.`
      : ''
    alert(
      `Onboarding task dispatched (${dispatched.task_id}).\n\n` +
      `Check the Tasks tab for progress. The agent will work on a branch ` +
      `(claude/onboard-…) and open a PR once it's done.${installedNote}`
    )
  } catch (err) {
    alert(`Could not dispatch onboarding: ${(err as Error).message}`)
  }
}

function ONBOARDING_PROMPT(name: string, repo: string): string {
  return `Onboard the project "${name}" (repo: ${repo}) into Holden Mercer.

This repo may have been started elsewhere — Cursor, Claude Code, Bolt, Lovable, v0,
or hand-coded. Your job: read what exists, then set up the .holdenmercer/ scaffolding
so future Claude sessions have proper context and won't go rogue.

DOCTRINE: work on a branch (claude/onboard-<short-date>), claim_work, run_gate,
open_pull_request, merge_pull_request (gate-protected). The PR is the user's
review surface — they'll see your suggested brief + invariants before anything
lands on main.

Steps:

1. PRE-FLIGHT — call check_recent_activity to see what's already going on.

2. EXPLORE the repo:
   - read_github_file README.md (if exists)
   - read_github_file package.json / pyproject.toml / requirements.txt /
     Cargo.toml / go.mod (whichever exists)
   - list_github_dir on the root + on src/ or app/ or lib/ to find the most
     populated source directory
   - read_github_file the top 6-10 source files in that directory
   - search_repo_code for "TODO" and "FIXME" to spot unfinished work

3. WRITE the BRIEF — commit_changes with .holdenmercer/brief.md:
       # ${name}
       ## What this is
       (1-3 sentence summary inferred from the codebase)
       ## Stack
       (bullet list: language, framework, key deps, build tool, test runner)
       ## Conventions
       (bullet list: file layout, naming, state mgmt, styling — only what's
        actually visible in the code, no invented standards)
       ## Out of scope
       (bullet list: things the project intentionally does NOT do, if obvious)

4. WRITE the INVARIANTS — same commit, .holdenmercer/invariants.md:
   3 to 7 things that must NOT break, tuned to THIS project. Examples:
       - The app builds with \`npm run build\`
       - All existing tests pass
       - The /login route renders without errors
       - The README quick-start commands still work
   Don't invent invariants you can't verify. Be specific to what you saw.

5. INSTALL the gate workflow — call setup_gate_workflow.

6. Run the gate once on your branch to confirm it works on the current code.
   If it fails, that's a useful signal — note it in your brief but don't try
   to fix the existing project's problems as part of onboarding.

7. open_pull_request titled "chore: onboard with Holden Mercer", body explains
   what you found and what scaffolding you wrote. Then merge_pull_request
   (it'll refuse if the gate failed, which is correct — let the user resolve
   the gate failure on a follow-up PR).

8. report_result with a one-paragraph summary of: what stack you found,
   what brief you wrote, what invariants, gate status (pass/fail/not-run),
   and any TODOs or unfinished work you spotted that the user should know about.

Be thorough but quick. This is one-shot setup — get it right then exit.`
}
