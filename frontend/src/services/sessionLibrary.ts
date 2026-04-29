/**
 * Saved-session library — a list of past dictation sessions persisted to
 * localStorage. Distinct from stores/dictation.ts (the LIVE current session).
 *
 * Replaces the older flat-string `dictationStore.ts`. Each session stores
 * the full segment list so re-opening preserves timestamps + confidence
 * and SRT export still works after reload.
 */

import type { TranscriptionSegment } from '@/stores/dictation'

export type WritingStyle =
  | 'professional' | 'casual' | 'academic' | 'creative' | 'technical'

export interface SavedSession {
  id:        string
  title:     string
  style:     WritingStyle
  segments:  TranscriptionSegment[]
  polished:  string | null
  word_count: number
  created:   number
  updated:   number
}

const KEY = 'holdenmercer:dictation:sessions:v2'

interface SerializedSegment extends Omit<TranscriptionSegment, 'timestamp'> {
  timestamp: string
}
interface SerializedSession extends Omit<SavedSession, 'segments'> {
  segments: SerializedSegment[]
}

function serialize(s: SavedSession): SerializedSession {
  return {
    ...s,
    segments: s.segments.map((seg) => ({ ...seg, timestamp: seg.timestamp.toISOString() })),
  }
}
function deserialize(s: SerializedSession): SavedSession {
  return {
    ...s,
    segments: s.segments.map((seg) => ({ ...seg, timestamp: new Date(seg.timestamp) })),
  }
}

function readAll(): SavedSession[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as SerializedSession[]
    return Array.isArray(parsed) ? parsed.map(deserialize) : []
  } catch {
    return []
  }
}

function writeAll(sessions: SavedSession[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(sessions.map(serialize)))
  } catch {
    if (sessions.length > 1) {
      try { localStorage.setItem(KEY, JSON.stringify(sessions.slice(0, -1).map(serialize))) }
      catch { /* give up */ }
    }
  }
}

const wordsOf = (segments: TranscriptionSegment[]): number =>
  segments.reduce(
    (c, s) => c + (s.correctedText || s.text).split(/\s+/).filter(Boolean).length, 0)

export const SessionLibrary = {
  list(): SavedSession[] {
    return readAll().sort((a, b) => b.updated - a.updated)
  },

  get(id: string): SavedSession | null {
    return readAll().find(s => s.id === id) ?? null
  },

  search(query: string): SavedSession[] {
    const q = query.trim().toLowerCase()
    if (!q) return SessionLibrary.list()
    return SessionLibrary.list().filter(s => {
      if (s.title.toLowerCase().includes(q)) return true
      if (s.polished?.toLowerCase().includes(q)) return true
      return s.segments.some(seg =>
        (seg.correctedText || seg.text).toLowerCase().includes(q))
    })
  },

  create(initial: Partial<SavedSession> = {}): SavedSession {
    const now = Date.now()
    const session: SavedSession = {
      id:         crypto.randomUUID(),
      title:      initial.title    ?? 'Untitled session',
      style:      initial.style    ?? 'professional',
      segments:   initial.segments ?? [],
      polished:   initial.polished ?? null,
      word_count: wordsOf(initial.segments ?? []),
      created:    now,
      updated:    now,
    }
    const all = readAll()
    all.unshift(session)
    writeAll(all)
    return session
  },

  update(id: string, patch: Partial<SavedSession>): SavedSession | null {
    const all = readAll()
    const idx = all.findIndex(s => s.id === id)
    if (idx < 0) return null
    const next: SavedSession = {
      ...all[idx],
      ...patch,
      updated:    Date.now(),
      word_count: wordsOf(patch.segments ?? all[idx].segments),
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
