/**
 * SovereignVoice — Deepgram nova-2 live transcription + Haiku refinement.
 *
 * Uses the native WebSocket API directly (no SDK import) so the bundle
 * stays lean and the code works identically in every browser.
 *
 * Architecture:
 *   Browser mic → MediaRecorder (250ms chunks)
 *       → Deepgram WSS (nova-2, endpointing=300)
 *           → interim results  → onInterimTranscript()
 *           → speech_final     → POST /api/refine → onRefined()
 *
 * Settings translated from the Kotlin DeepgramClient recipe:
 *   model=nova-2, smart_format, punctuate, interim_results, endpointing=300
 *
 * The `endpointing: 300` is the secret to speed — speech_final fires after
 * just 300ms of silence, so Haiku refinement starts immediately.
 *
 * SECURITY NOTE: VITE_DEEPGRAM_API_KEY lands in the browser bundle.
 * Acceptable for a personal local tool. For production, proxy the WebSocket
 * through the FastAPI backend so the key stays server-side.
 */

// ── Public types ─────────────────────────────────────────────────────────────

export type VoiceStatus =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'speech_final'
  | 'refining'
  | 'refined'
  | 'executing'
  | 'overnight_queued'
  | 'error'

export interface RefineResult {
  session_id: string
  transcript: string
  refined_text: string
  intent: string
  mcp_refs: string[]
  execution_keyword: string | null
  task_complexity: string
  processing_ms: number
}

export interface CommandResult {
  ok: boolean
  session_id: string
  mode: string
  model: string
  refined: RefineResult
  response: string | null
  execution: Record<string, unknown> | null
  cache_hit: boolean
  thinking_used: boolean
  warnings: string[]
  processing_ms: number
}

export interface SovereignVoiceOptions {
  deepgramApiKey: string
  sovereignApiKey?: string
  onStatusChange:       (status: VoiceStatus) => void
  onInterimTranscript:  (text: string) => void
  onSpeechFinal:        (rawTranscript: string) => void
  onRefined:            (result: RefineResult) => void
  onError:              (message: string) => void
  onStreamReady?:       (stream: MediaStream | null) => void
}

// ── Deepgram settings (from the Kotlin recipe) ───────────────────────────────

const DG_HOST = 'wss://api.deepgram.com/v1/listen'
const DG_PARAMS = new URLSearchParams({
  model:           'nova-2',
  smart_format:    'true',
  punctuate:       'true',
  interim_results: 'true',
  endpointing:     '300',   // ← 300ms silence → speech_final fires
})

// ── Deepgram result shape ─────────────────────────────────────────────────────

interface DGTranscriptMessage {
  type:         'Results'
  channel:      { alternatives: Array<{ transcript: string; confidence: number }> }
  is_final:     boolean
  speech_final: boolean
  duration:     number
  start:        number
}

// ── Service class ─────────────────────────────────────────────────────────────

export class SovereignVoice {
  private socket:      WebSocket | null = null
  private microphone:  MediaRecorder | null = null
  private utterance = ''
  private _status: VoiceStatus = 'idle'

  constructor(private options: SovereignVoiceOptions) {}

  get status(): VoiceStatus { return this._status }

  // ── Connect ──────────────────────────────────────────────────────────────
  async connect(): Promise<void> {
    if (this._status !== 'idle' && this._status !== 'error') return

    this.setStatus('connecting')

    const url = `${DG_HOST}?${DG_PARAMS}`
    this.socket = new WebSocket(url, ['token', this.options.deepgramApiKey])

    this.socket.onopen = async () => {
      this.setStatus('listening')
      await this.openMicrophone()
    }

    this.socket.onmessage = (event: MessageEvent<string>) => {
      try {
        const msg = JSON.parse(event.data) as DGTranscriptMessage
        if (msg.type === 'Results') this.handleTranscript(msg)
      } catch { /* non-JSON frames (keepalive etc.) — ignore */ }
    }

    this.socket.onclose = () => {
      if (this._status !== 'error') this.setStatus('idle')
    }

    this.socket.onerror = () => {
      this.options.onError('Deepgram WebSocket error — check your API key and network.')
      this.setStatus('error')
    }
  }

  // ── Disconnect ───────────────────────────────────────────────────────────
  disconnect(): void {
    this.microphone?.stream?.getTracks().forEach(t => t.stop())
    this.options.onStreamReady?.(null)
    this.microphone = null
    this.socket?.close()
    this.socket = null
    this.utterance = ''
    this.setStatus('idle')
  }

  // ── Transcript handler ───────────────────────────────────────────────────
  private handleTranscript(msg: DGTranscriptMessage): void {
    const transcript = msg.channel.alternatives[0]?.transcript ?? ''

    if (!msg.is_final) {
      // Interim — display live, don't accumulate
      this.options.onInterimTranscript(this.utterance + transcript)
      return
    }

    // Final segment — accumulate
    this.utterance = (this.utterance + ' ' + transcript).trim()

    if (msg.speech_final) {
      const full = this.utterance
      this.utterance = ''
      if (!full) return

      this.setStatus('speech_final')
      this.options.onSpeechFinal(full)
      this.refine(full)
    }
  }

  // ── Open microphone → stream to Deepgram ─────────────────────────────────
  private async openMicrophone(): Promise<void> {
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      this.options.onError('Microphone access denied. Allow mic permissions and retry.')
      this.setStatus('error')
      return
    }

    const mimeType = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
    ].find(m => MediaRecorder.isTypeSupported(m)) ?? ''

    this.options.onStreamReady?.(stream)
    this.microphone = new MediaRecorder(stream, mimeType ? { mimeType } : {})

    this.microphone.ondataavailable = (e: BlobEvent) => {
      if (e.data.size > 0 && this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(e.data)
      }
    }

    this.microphone.onerror = () => {
      this.options.onError('MediaRecorder error — mic may have been disconnected.')
      this.setStatus('error')
    }

    this.microphone.start(250)  // 250ms chunks = low latency
  }

  // ── POST /api/refine — Haiku 4.5 gibberish killer ────────────────────────
  private async refine(transcript: string): Promise<void> {
    this.setStatus('refining')

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.options.sovereignApiKey) headers['X-Sovereign-Key'] = this.options.sovereignApiKey

    try {
      const res = await fetch('/api/refine', {
        method: 'POST',
        headers,
        body: JSON.stringify({ text: transcript, session_id: crypto.randomUUID() }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw new Error((err as Record<string, string>).detail ?? `HTTP ${res.status}`)
      }
      const result: RefineResult = await res.json()
      this.options.onRefined(result)
      this.setStatus('refined')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.options.onError(`Refine failed: ${msg}`)
      this.setStatus('listening')  // resume listening even if refine fails
    }
  }

  // ── Execute (immediate) ──────────────────────────────────────────────────
  async execute(result: RefineResult): Promise<CommandResult | null> {
    this.setStatus('executing')
    return this.postCommand(result, false)
  }

  // ── Overnight queue (Batch API) ──────────────────────────────────────────
  async queueOvernight(result: RefineResult): Promise<CommandResult | null> {
    this.setStatus('overnight_queued')
    return this.postCommand(result, true)
  }

  private async postCommand(result: RefineResult, forceBatch: boolean): Promise<CommandResult | null> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.options.sovereignApiKey) headers['X-Sovereign-Key'] = this.options.sovereignApiKey

    try {
      const res = await fetch('/api/command', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          text:        result.refined_text,
          mode:        'execute',
          session_id:  result.session_id,
          skip_refine: true,
          force_batch: forceBatch,
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json() as Promise<CommandResult>
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.options.onError(`Command failed: ${msg}`)
      this.setStatus('refined')
      return null
    }
  }

  private setStatus(status: VoiceStatus): void {
    this._status = status
    this.options.onStatusChange(status)
  }
}
