/**
 * Brief — the project's mission statement.
 *
 * Lives in the project record (localStorage) AND, when the project is linked
 * to a GitHub repo, mirrors to .holdenmercer/brief.md on every save. That file
 * is what Claude reads on session start, so it survives across devices and
 * gives a new session full context without the user re-explaining.
 */

import { useEffect, useState } from 'react'
import { useProjects } from '../stores/projects'
import { writeMeta } from '../lib/repo'

interface Props {
  projectId: string
}

type SyncState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: number }
  | { kind: 'error'; message: string }

export function Brief({ projectId }: Props) {
  const project = useProjects((s) => s.projects.find((p) => p.id === projectId))
  const update  = useProjects((s) => s.update)
  const [draft, setDraft]     = useState(project?.description ?? '')
  const [dirty, setDirty]     = useState(false)
  const [sync,  setSync]      = useState<SyncState>({ kind: 'idle' })

  useEffect(() => {
    setDraft(project?.description ?? '')
    setDirty(false)
    setSync({ kind: 'idle' })
  }, [projectId, project?.description])

  if (!project) return null

  const save = async () => {
    if (!dirty) return
    const next = draft.trim()
    update(projectId, { description: next })
    setDirty(false)

    if (project.repo) {
      setSync({ kind: 'saving' })
      try {
        await writeMeta(
          project.repo,
          'brief.md',
          briefMarkdown(project.name, next),
          'Update Holden Mercer brief',
        )
        setSync({ kind: 'saved', at: Date.now() })
      } catch (err) {
        setSync({ kind: 'error', message: (err as Error).message })
      }
    } else {
      setSync({ kind: 'saved', at: Date.now() })
    }
  }

  return (
    <div className="hm-brief">
      <header className="hm-brief-header">
        <h2 className="hm-brief-title">Brief</h2>
        <p className="hm-brief-help">
          What you're building, in your own words. Claude reads this on every
          session — keep it specific. Goals, constraints, decisions you've
          already made.{' '}
          {project.repo
            ? <>Saving commits to <code>.holdenmercer/brief.md</code> in <code>{project.repo}</code>.</>
            : <>Link a repo (top-right above the tabs) to back this up.</>}
        </p>
      </header>

      <textarea
        className="hm-textarea hm-brief-textarea"
        value={draft}
        onChange={(e) => { setDraft(e.target.value); setDirty(true) }}
        onBlur={save}
        rows={16}
        placeholder="A landing page for my glassblowing studio. Editorial, dark theme, gallery + booking form. Must work on mobile. Use Tailwind. No backend — bookings go through a Google Form."
        autoCapitalize="sentences"
        autoCorrect="on"
        spellCheck
      />

      <div className="hm-brief-footer">
        <span className="hm-brief-status">
          {dirty ? 'Unsaved — click outside or hit Save.'
            : sync.kind === 'saving' ? 'Committing to repo…'
            : sync.kind === 'error'  ? `Sync failed: ${sync.message}`
            : sync.kind === 'saved'  ? 'Saved.' : 'Saved.'}
        </span>
        <button className="hm-btn-primary" onClick={save} disabled={!dirty}>
          Save brief
        </button>
      </div>
    </div>
  )
}

function briefMarkdown(name: string, description: string): string {
  return `# ${name}\n\n${description.trim()}\n\n---\n\n_Maintained by Holden Mercer (holdenmercer.com)._\n`
}
