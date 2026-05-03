/**
 * Brief — the project's mission statement.
 *
 * Lives in the project record (localStorage) for now. PR B will write it to
 * the project's GitHub repo as `.holdenmercer/brief.md` so it survives any
 * Claude session — the brief becomes the first thing a new session reads.
 */

import { useEffect, useState } from 'react'
import { useProjects } from '../stores/projects'

interface Props {
  projectId: string
}

export function Brief({ projectId }: Props) {
  const project = useProjects((s) => s.projects.find((p) => p.id === projectId))
  const update  = useProjects((s) => s.update)
  const [draft, setDraft]   = useState(project?.description ?? '')
  const [saved, setSaved]   = useState(true)

  useEffect(() => {
    setDraft(project?.description ?? '')
    setSaved(true)
  }, [projectId, project?.description])

  if (!project) return null

  const save = () => {
    update(projectId, { description: draft.trim() })
    setSaved(true)
  }

  return (
    <div className="hm-brief">
      <header className="hm-brief-header">
        <h2 className="hm-brief-title">Brief</h2>
        <p className="hm-brief-help">
          What you're building, in your own words. Claude reads this on every
          session — keep it specific. Goals, constraints, anything that should
          shape every decision.
        </p>
      </header>

      <textarea
        className="hm-textarea hm-brief-textarea"
        value={draft}
        onChange={(e) => { setDraft(e.target.value); setSaved(false) }}
        onBlur={save}
        rows={16}
        placeholder="A landing page for my glassblowing studio. Editorial, dark theme, gallery + booking form. Must work on mobile. Use Tailwind. No backend — bookings go through a Google Form."
        autoCapitalize="sentences"
        autoCorrect="on"
        spellCheck
      />

      <div className="hm-brief-footer">
        <span className="hm-brief-status">
          {saved ? 'Saved.' : 'Unsaved — click outside to save.'}
        </span>
        <button className="hm-btn-primary" onClick={save} disabled={saved}>
          Save brief
        </button>
      </div>
    </div>
  )
}
