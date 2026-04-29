/**
 * dictationStore — local-first session persistence.
 *
 * Sessions live in localStorage under a versioned key so we can migrate
 * the schema later without nuking user data. Newest first.
 */

export type WritingStyle = 'professional' | 'casual' | 'academic' | 'creative' | 'technical'

export interface DictationSegment {
  ts:   number       // ms since epoch
  text: string       // verbatim utterance OR formatted command output
  raw:  string       // original transcript (for SRT export)
}

export interface DictationSession {
  id:        string
  title:     string
  style:     WritingStyle
  raw_text:  string         // accumulated unpolished body
  polished:  string | null  // last polish output
  segments:  DictationSegment[]
  word_count: number
  created:   number
  updated:   number
}

const KEY = 'holdenmercer:dictation:sessions:v1'

function readAll(): DictationSession[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const data = JSON.parse(raw) as DictationSession[]
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

function writeAll(sessions: DictationSession[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(sessions))
  } catch {
    // quota exceeded — drop oldest and retry once
    if (sessions.length > 1) {
      try {
        localStorage.setItem(KEY, JSON.stringify(sessions.slice(0, -1)))
      } catch { /* give up silently */ }
    }
  }
}

export const DictationStore = {
  list(): DictationSession[] {
    return readAll().sort((a, b) => b.updated - a.updated)
  },

  get(id: string): DictationSession | null {
    return readAll().find(s => s.id === id) ?? null
  },

  search(query: string): DictationSession[] {
    const q = query.trim().toLowerCase()
    if (!q) return DictationStore.list()
    return DictationStore.list().filter(s =>
      s.title.toLowerCase().includes(q) ||
      s.raw_text.toLowerCase().includes(q) ||
      (s.polished?.toLowerCase().includes(q) ?? false)
    )
  },

  create(initial: Partial<DictationSession> = {}): DictationSession {
    const now = Date.now()
    const session: DictationSession = {
      id:         crypto.randomUUID(),
      title:      initial.title    ?? 'Untitled session',
      style:      initial.style    ?? 'professional',
      raw_text:   initial.raw_text ?? '',
      polished:   initial.polished ?? null,
      segments:   initial.segments ?? [],
      word_count: countWords(initial.raw_text ?? ''),
      created:    now,
      updated:    now,
    }
    const all = readAll()
    all.unshift(session)
    writeAll(all)
    return session
  },

  update(id: string, patch: Partial<DictationSession>): DictationSession | null {
    const all = readAll()
    const idx = all.findIndex(s => s.id === id)
    if (idx < 0) return null
    const next: DictationSession = {
      ...all[idx],
      ...patch,
      updated: Date.now(),
      word_count: countWords(patch.raw_text ?? all[idx].raw_text),
    }
    all[idx] = next
    writeAll(all)
    return next
  },

  remove(id: string): void {
    writeAll(readAll().filter(s => s.id !== id))
  },

  clear(): void {
    try { localStorage.removeItem(KEY) } catch {}
  },
}

function countWords(text: string): number {
  const t = text.trim()
  return t ? t.split(/\s+/).length : 0
}

// ── Exporters ───────────────────────────────────────────────────────────────

export function exportTxt(s: DictationSession): string {
  return s.polished?.trim() || s.raw_text.trim()
}

export function exportMarkdown(s: DictationSession): string {
  const created = new Date(s.created).toISOString().slice(0, 19).replace('T', ' ')
  const body = s.polished?.trim() || s.raw_text.trim()
  return `# ${s.title}\n\n*${created} · ${s.style} · ${s.word_count} words*\n\n${body}\n`
}

export function exportJson(s: DictationSession): string {
  return JSON.stringify(s, null, 2)
}

export function exportSrt(s: DictationSession): string {
  if (!s.segments.length) return ''
  const start = s.segments[0]?.ts ?? Date.now()
  return s.segments.map((seg, i) => {
    const offsetMs = seg.ts - start
    const nextMs   = (s.segments[i + 1]?.ts ?? seg.ts + 3000) - start
    return [
      String(i + 1),
      `${srtTime(offsetMs)} --> ${srtTime(nextMs)}`,
      seg.raw || seg.text,
      '',
    ].join('\n')
  }).join('\n')
}

function srtTime(ms: number): string {
  const safe = Math.max(0, ms)
  const h  = Math.floor(safe / 3_600_000)
  const m  = Math.floor((safe % 3_600_000) / 60_000)
  const s  = Math.floor((safe % 60_000) / 1000)
  const ms3 = safe % 1000
  return `${pad(h)}:${pad(m)}:${pad(s)},${String(ms3).padStart(3, '0')}`
}

function pad(n: number): string { return String(n).padStart(2, '0') }

export function downloadFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
