/**
 * NewProjectModal — captures name + description, creates the project, and
 * closes. Project lives only in localStorage until PR B wires the GitHub
 * repo backend.
 */

import { useState } from 'react'
import { useProjects } from '../stores/projects'

interface Props {
  open:    boolean
  onClose: () => void
}

export function NewProjectModal({ open, onClose }: Props) {
  const create = useProjects((s) => s.create)
  const [name, setName]               = useState('')
  const [description, setDescription] = useState('')

  if (!open) return null

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    create({ name, description })
    setName('')
    setDescription('')
    onClose()
  }

  return (
    <div className="hm-modal-backdrop" onClick={onClose}>
      <form
        className="hm-modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2 className="hm-modal-title">New project</h2>
        <p className="hm-modal-lede">
          A project is one thing you're building. Give it a name and a one-line
          brief — Claude reads the brief on every session so it knows what you're
          trying to make.
        </p>

        <label className="hm-field">
          <span className="hm-field-label">Name</span>
          <input
            className="hm-input"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Glassblade"
            autoFocus
            autoCapitalize="words"
            spellCheck
          />
        </label>

        <label className="hm-field">
          <span className="hm-field-label">Brief</span>
          <textarea
            className="hm-textarea"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="A landing page for my glassblowing studio. Editorial, dark theme, gallery + booking form."
            rows={4}
            autoCapitalize="sentences"
            autoCorrect="on"
            spellCheck
          />
        </label>

        <div className="hm-modal-actions">
          <button type="button" className="hm-btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="hm-btn-primary" disabled={!name.trim()}>
            Create project
          </button>
        </div>
      </form>
    </div>
  )
}
