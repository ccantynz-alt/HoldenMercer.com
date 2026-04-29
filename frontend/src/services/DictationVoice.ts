/**
 * DictationVoice — Deepgram nova-2 streaming transcription tuned for
 * long-form dictation, NOT command refinement.
 *
 * Pipeline:
 *   Browser mic → MediaRecorder (250ms) → Deepgram WSS
 *     → interim   → onInterim()
 *     → final     → onFinal(rawSegment)   // caller runs voice-cmd + smart-format
 *
 * Voxlen's audio capture is Tauri/Rust-bound (cpal); the web port uses
 * MediaRecorder + WebSocket because we run in the browser. Voice commands
 * are intentionally NOT parsed inside this class — callers feed final
 * segments through `lib/voiceCommands` so all the matching rules live in
 * one place and the parser stays unit-testable.
 */

export type DictationVoiceStatus =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'paused'
  | 'error'

export interface DictationVoiceOptions {
  deepgramApiKey: string
  onStatusChange:    (status: DictationVoiceStatus) => void
  onInterim:         (text: string) => void
  onFinal:           (text: string, confidence: number) => void
  onError:           (msg: string) => void
  onStreamReady?:    (stream: MediaStream | null) => void
}

const DG_HOST = 'wss://api.deepgram.com/v1/listen'
const DG_PARAMS = new URLSearchParams({
  model:           'nova-2',
  smart_format:    'true',
  punctuate:       'true',
  interim_results: 'true',
  endpointing:     '300',
})

interface DGTranscriptMessage {
  type:         'Results'
  channel:      { alternatives: Array<{ transcript: string; confidence: number }> }
  is_final:     boolean
  speech_final: boolean
}

export class DictationVoice {
  private socket:     WebSocket | null = null
  private microphone: MediaRecorder | null = null
  private utterance       = ''
  private utteranceConf   = 1
  private _status: DictationVoiceStatus = 'idle'

  constructor(private options: DictationVoiceOptions) {}

  get status(): DictationVoiceStatus { return this._status }

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
      } catch { /* ignore non-JSON keepalives */ }
    }

    this.socket.onclose = () => {
      if (this._status !== 'error') this.setStatus('idle')
    }

    this.socket.onerror = () => {
      this.options.onError('Deepgram socket error — check your API key and network.')
      this.setStatus('error')
    }
  }

  disconnect(): void {
    this.microphone?.stream?.getTracks().forEach(t => t.stop())
    this.options.onStreamReady?.(null)
    this.microphone = null
    this.socket?.close()
    this.socket = null
    this.utterance = ''
    this.utteranceConf = 1
    this.setStatus('idle')
  }

  private handleTranscript(msg: DGTranscriptMessage): void {
    const alt = msg.channel.alternatives[0]
    const transcript = alt?.transcript ?? ''
    const confidence = alt?.confidence ?? 1

    if (!msg.is_final) {
      this.options.onInterim(this.utterance + transcript)
      return
    }

    this.utterance     = (this.utterance + ' ' + transcript).trim()
    this.utteranceConf = Math.min(this.utteranceConf, confidence)

    if (msg.speech_final) {
      const full = this.utterance
      const conf = this.utteranceConf
      this.utterance     = ''
      this.utteranceConf = 1
      if (!full) return
      this.options.onFinal(full, conf)
    }
  }

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

    this.microphone.start(250)
  }

  private setStatus(status: DictationVoiceStatus): void {
    this._status = status
    this.options.onStatusChange(status)
  }
}
