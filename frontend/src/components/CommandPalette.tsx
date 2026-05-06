/**
 * CommandPalette — Cmd-K / Ctrl-K global launcher.
 *
 * Type to filter, ↑↓ to navigate, Enter to run, Esc to close.
 *
 * Commands are dynamically composed from:
 *   • Every linked project (jump straight in)
 *   • Every tab within the current project (if one is active)
 *   • Top-level admin actions (new project, settings, audit log, fix HM, sign out)
 *
 * The palette is mounted globally in App.jsx and listens for the keyboard
 * shortcut. Always-on, never blocks.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useProjects } from '../stores/projects'
import { useAuth } from '../stores/auth'

interface Command {
  id:    string
  label: string
  hint?: string
  group: 'projects' | 'tabs' | 'admin'
  run:   () => void
}

interface Props {
  /** Called by App.jsx when the palette wants to perform certain actions. */
  onNewProject:   () => void
  onOpenSettings: () => void
  onOpenFix:      () => void
  onGoHome:       () => void
}

export function CommandPalette({
  onNewProject, onOpenSettings, onOpenFix, onGoHome,
}: Props) {
  const projects        = useProjects((s) => s.projects)
  const activeProjectId = useProjects((s) => s.activeProjectId)
  const setActive       = useProjects((s) => s.setActive)
  const logout          = useAuth((s) => s.logout)

  const [open,   setOpen]   = useState(false)
  const [query,  setQuery]  = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Global Cmd-K / Ctrl-K shortcut
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setOpen((v) => !v)
      } else if (e.key === 'Escape' && open) {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  useEffect(() => {
    if (open) {
      setQuery('')
      setCursor(0)
      setTimeout(() => inputRef.current?.focus(), 30)
    }
  }, [open])

  const commands: Command[] = useMemo(() => {
    const out: Command[] = []

    // Top-level admin actions
    out.push({
      id:    'admin:home',
      label: 'Go to Home',
      hint:  'Activity dashboard',
      group: 'admin',
      run:   () => { onGoHome(); setOpen(false) },
    })
    out.push({
      id:    'admin:new',
      label: '+ New project',
      group: 'admin',
      run:   () => { onNewProject(); setOpen(false) },
    })
    out.push({
      id:    'admin:settings',
      label: 'Open Settings',
      hint:  'API keys, autonomy, model defaults',
      group: 'admin',
      run:   () => { onOpenSettings(); setOpen(false) },
    })
    out.push({
      id:    'admin:fix',
      label: '🔧 Fix the dashboard',
      hint:  'Dispatch a self-repair task on Holden Mercer itself',
      group: 'admin',
      run:   () => { onOpenFix(); setOpen(false) },
    })
    out.push({
      id:    'admin:logout',
      label: 'Sign out',
      group: 'admin',
      run:   () => { logout(); setOpen(false) },
    })

    // Projects — jump to each
    for (const p of projects) {
      const isActive = p.id === activeProjectId
      out.push({
        id:    `project:${p.id}`,
        label: `${isActive ? '→ ' : ''}${p.name}`,
        hint:  p.repo ? `📦 ${p.repo}` : 'no repo linked',
        group: 'projects',
        run:   () => { setActive(p.id); setOpen(false) },
      })
    }

    return out
  }, [projects, activeProjectId, setActive, logout, onNewProject, onOpenSettings, onOpenFix, onGoHome])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    return commands.filter((c) =>
      c.label.toLowerCase().includes(q) ||
      (c.hint?.toLowerCase().includes(q) ?? false)
    )
  }, [commands, query])

  // Keep cursor in range
  useEffect(() => {
    if (cursor >= filtered.length) setCursor(Math.max(0, filtered.length - 1))
  }, [filtered.length, cursor])

  if (!open) return null

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(filtered.length - 1, c + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(0, c - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      filtered[cursor]?.run()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    }
  }

  return (
    <div
      onClick={() => setOpen(false)}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: '14vh',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(640px, 92vw)',
          background: 'var(--bg-elev, #1a1a1a)',
          border: '1px solid var(--border, #2a2a2a)',
          borderRadius: 12,
          boxShadow: '0 20px 60px rgba(0,0,0,0.45)',
          overflow: 'hidden',
        }}
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setCursor(0) }}
          onKeyDown={onKeyDown}
          placeholder="Type a command, or pick a project…"
          style={{
            width: '100%', padding: '14px 18px',
            background: 'transparent', border: 'none', outline: 'none',
            fontSize: 16, color: 'var(--text, #eee)',
            borderBottom: '1px solid var(--border, #2a2a2a)',
          }}
          autoComplete="off"
          spellCheck={false}
        />
        <ul
          style={{
            listStyle: 'none', margin: 0, padding: 6,
            maxHeight: '50vh', overflowY: 'auto',
          }}
        >
          {filtered.length === 0 && (
            <li style={{ padding: 16, color: 'var(--text-muted)', fontSize: 14 }}>
              No matches.
            </li>
          )}
          {filtered.map((c, i) => (
            <li key={c.id}>
              <button
                onClick={() => c.run()}
                onMouseEnter={() => setCursor(i)}
                style={{
                  width: '100%', textAlign: 'left',
                  padding: '8px 12px', borderRadius: 8,
                  background: i === cursor ? 'var(--bg-active, #2a2a2a)' : 'transparent',
                  border: 'none', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  color: 'var(--text, #eee)',
                }}
              >
                <span>
                  <span style={{
                    fontSize: 10, textTransform: 'uppercase', marginRight: 8,
                    color: 'var(--text-muted)', letterSpacing: '0.06em',
                  }}>
                    {c.group}
                  </span>
                  {c.label}
                </span>
                {c.hint && (
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{c.hint}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
        <div style={{
          padding: '6px 14px',
          borderTop: '1px solid var(--border, #2a2a2a)',
          fontSize: 11, color: 'var(--text-muted)',
          display: 'flex', justifyContent: 'space-between',
        }}>
          <span>↑↓ navigate · enter run · esc close</span>
          <span>{filtered.length} {filtered.length === 1 ? 'match' : 'matches'}</span>
        </div>
      </div>
    </div>
  )
}
