/**
 * Transcript export. Adapted from Voxlen
 * (https://github.com/ccantynz-alt/voxlen/blob/main/src/lib/export.ts) —
 * Tauri save-dialog fallback dropped; web blob download is the default path.
 */

import type { TranscriptionSegment } from '@/stores/dictation'

export type ExportFormat = 'txt' | 'md' | 'json' | 'srt'

export function exportTranscript(
  segments: TranscriptionSegment[],
  format: ExportFormat = 'txt',
  meta: { title?: string } = {},
): { content: string; filename: string; mimeType: string } {
  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-')
  const slug = (meta.title ?? 'holdenmercer-dictation')
    .replace(/[^a-z0-9-_]+/gi, '-').toLowerCase().slice(0, 60)

  switch (format) {
    case 'md':
      return {
        content:  formatAsMarkdown(segments, meta),
        filename: `${slug}-${timestamp}.md`,
        mimeType: 'text/markdown',
      }
    case 'json':
      return {
        content:  formatAsJson(segments, meta),
        filename: `${slug}-${timestamp}.json`,
        mimeType: 'application/json',
      }
    case 'srt':
      return {
        content:  formatAsSrt(segments),
        filename: `${slug}-${timestamp}.srt`,
        mimeType: 'text/srt',
      }
    case 'txt':
    default:
      return {
        content:  formatAsText(segments),
        filename: `${slug}-${timestamp}.txt`,
        mimeType: 'text/plain',
      }
  }
}

function formatAsText(segments: TranscriptionSegment[]): string {
  return segments.map((s) => s.correctedText || s.text).join(' ')
}

function formatAsMarkdown(
  segments: TranscriptionSegment[],
  meta: { title?: string } = {},
): string {
  const wc = segments.reduce(
    (c, s) => c + (s.correctedText || s.text).split(/\s+/).filter(Boolean).length, 0)
  const lines = [
    `# ${meta.title ?? 'HoldenMercer.com — Dictation Transcript'}`,
    '',
    `**Date:** ${new Date().toLocaleDateString()}`,
    `**Words:** ${wc}`,
    `**Segments:** ${segments.length}`,
    '',
    '---',
    '',
  ]

  segments.forEach((s) => {
    const time = s.timestamp.toLocaleTimeString()
    const text = s.correctedText || s.text
    const grammarTag = s.grammarApplied ? ' *(AI polished)*' : ''
    lines.push(`**[${time}]** ${text}${grammarTag}`)
    if (s.translatedText) {
      const lang = s.translatedToLanguage ? ` (${s.translatedToLanguage})` : ''
      lines.push(`> ${s.translatedText}${lang}`)
    }
    lines.push('')
  })

  return lines.join('\n')
}

function formatAsJson(
  segments: TranscriptionSegment[],
  meta: { title?: string } = {},
): string {
  return JSON.stringify(
    {
      version:  '1.0',
      app:      'HoldenMercer.com',
      title:    meta.title ?? null,
      exported: new Date().toISOString(),
      segments: segments.map((s) => ({
        id:                   s.id,
        text:                 s.text,
        correctedText:        s.correctedText      ?? null,
        translatedText:       s.translatedText     ?? null,
        translatedToLanguage: s.translatedToLanguage ?? null,
        timestamp:            s.timestamp.toISOString(),
        confidence:           s.confidence,
        language:             s.language ?? null,
        grammarApplied:       s.grammarApplied,
      })),
    },
    null,
    2,
  )
}

function formatAsSrt(segments: TranscriptionSegment[]): string {
  if (segments.length === 0) return ''
  const start0 = segments[0].timestamp.getTime()
  return segments
    .map((s, i) => {
      const offsetMs = s.timestamp.getTime() - start0
      const next = segments[i + 1]?.timestamp.getTime() ?? s.timestamp.getTime() + 3000
      const endMs = next - start0
      return `${i + 1}\n${formatSrtTime(offsetMs)} --> ${formatSrtTime(endMs)}\n${s.correctedText || s.text}\n`
    })
    .join('\n')
}

function formatSrtTime(ms: number): string {
  const safe = Math.max(0, ms)
  const h  = Math.floor(safe / 3_600_000)
  const m  = Math.floor((safe % 3_600_000) / 60_000)
  const s  = Math.floor((safe % 60_000) / 1000)
  const ms3 = safe % 1000
  return `${pad(h)}:${pad(m)}:${pad(s)},${String(ms3).padStart(3, '0')}`
}

function pad(n: number): string { return String(n).padStart(2, '0') }

export function downloadExport(
  segments: TranscriptionSegment[],
  format: ExportFormat,
  meta: { title?: string } = {},
): void {
  const { content, filename, mimeType } = exportTranscript(segments, format, meta)
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
