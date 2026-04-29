/**
 * Current-session dictation store.
 *
 * Adapted from Voxlen (https://github.com/ccantynz-alt/voxlen) — pure web port,
 * no Tauri bindings. Stores the LIVE session: segments accumulated during the
 * current dictation, plus status/duration/word count. Saved sessions live
 * separately in services/sessionLibrary.ts (localStorage).
 */

import { create } from 'zustand'

export type DictationStatus =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'processing'
  | 'paused'
  | 'error'

export interface TranscriptionSegment {
  id:              string
  text:            string
  correctedText?:  string
  translatedText?: string
  translatedToLanguage?: string
  timestamp:       Date
  confidence:      number
  language?:       string
  isFinal:         boolean
  grammarApplied:  boolean
}

interface DictationState {
  status: DictationStatus
  segments: TranscriptionSegment[]
  currentTranscript:    string   // live interim text (not yet final)
  correctedTranscript:  string   // last polish output, full session
  sessionDuration:      number   // seconds
  wordCount:            number
  inputLevel:           number
  error:                string | null
  sessionStartedAtMs:   number | null
  capsLock:             boolean

  // Actions
  setStatus:               (status: DictationStatus) => void
  addSegment:              (segment: TranscriptionSegment) => void
  updateSegment:           (id: string, updates: Partial<TranscriptionSegment>) => void
  popLastSegment:          () => void
  appendToLastSegment:     (text: string) => void
  setCurrentTranscript:    (text: string) => void
  setCorrectedTranscript:  (text: string) => void
  setInputLevel:           (level: number) => void
  setError:                (error: string | null) => void
  incrementDuration:       () => void
  clearSession:            () => void
  clearCurrentTranscript:  () => void
  getFullTranscript:       () => string
  setCapsLock:             (value: boolean) => void
  toggleCapsLock:          () => void
}

const wordsOf = (segments: TranscriptionSegment[]): number =>
  segments.reduce(
    (count, s) =>
      count + (s.correctedText || s.text).split(/\s+/).filter(Boolean).length,
    0,
  )

export const useDictationStore = create<DictationState>((set, get) => ({
  status: 'idle',
  segments: [],
  currentTranscript:    '',
  correctedTranscript:  '',
  sessionDuration:      0,
  wordCount:            0,
  inputLevel:           0,
  error:                null,
  sessionStartedAtMs:   null,
  capsLock:             false,

  setStatus: (status) =>
    set((state) => {
      const sessionStartedAtMs =
        status === 'listening' && state.status === 'idle'
          ? Date.now()
          : state.sessionStartedAtMs
      return { status, sessionStartedAtMs }
    }),

  addSegment: (segment) =>
    set((state) => {
      const segments = [...state.segments, segment]
      return { segments, wordCount: wordsOf(segments) }
    }),

  updateSegment: (id, updates) =>
    set((state) => {
      const segments = state.segments.map((s) =>
        s.id === id ? { ...s, ...updates } : s,
      )
      return { segments, wordCount: wordsOf(segments) }
    }),

  popLastSegment: () =>
    set((state) => {
      if (state.segments.length === 0) return {}
      const segments = state.segments.slice(0, -1)
      return { segments, wordCount: wordsOf(segments) }
    }),

  appendToLastSegment: (text) =>
    set((state) => {
      if (state.segments.length === 0) return {}
      const segments = [...state.segments]
      const last = segments[segments.length - 1]
      const nextText = (last.correctedText ?? last.text) + text
      segments[segments.length - 1] = last.correctedText
        ? { ...last, correctedText: nextText }
        : { ...last, text: nextText }
      return { segments, wordCount: wordsOf(segments) }
    }),

  setCurrentTranscript:   (text) => set({ currentTranscript: text }),
  setCorrectedTranscript: (text) => set({ correctedTranscript: text }),
  setInputLevel:          (level) => set({ inputLevel: level }),
  setError:               (error) => set({ error, status: error ? 'error' : 'idle' }),
  incrementDuration:      () => set((state) => ({ sessionDuration: state.sessionDuration + 1 })),

  clearSession: () =>
    set({
      segments: [],
      currentTranscript:    '',
      correctedTranscript:  '',
      sessionDuration:      0,
      wordCount:            0,
      inputLevel:           0,
      error:                null,
      status:               'idle',
      sessionStartedAtMs:   null,
    }),

  clearCurrentTranscript: () => set({ currentTranscript: '' }),

  getFullTranscript: () =>
    get().segments.map((s) => s.correctedText || s.text).join(' '),

  setCapsLock:    (value) => set({ capsLock: value }),
  toggleCapsLock: () => set((state) => ({ capsLock: !state.capsLock })),
}))
