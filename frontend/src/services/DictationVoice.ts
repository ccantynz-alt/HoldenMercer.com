/**
 * DictationVoice — Deepgram nova-2 streaming transcription tuned for
 * long-form dictation (not command refinement).
 *
 * Differences vs. SovereignVoice:
 *   • No /api/refine call on each speech_final — segments commit straight
 *     to the writing surface.
 *   • Intercepts spoken commands ("new line", "period", "stop dictation"…)
 *     and turns them into formatting actions instead of literal text.
 *   • Exposes a stream of TranscriptEvents the UI can subscribe to.
 *
 * Architecture:
 *   Browser mic → MediaRecorder (250ms) → Deepgram WSS
 *     → interim   → onInterim()
 *     → final     → command parser → onCommit() OR onCommand()
 */

export type DictationStatus =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'paused'
  | 'error'

export type DictationCommand =
  | 'new_line'
  | 'new_paragraph'
  | 'period'
  | 'comma'
  | 'question_mark'
  | 'exclamation'
  | 'colon'
  | 'semicolon'
  | 'delete_word'
  | 'undo'
  | 'stop'

export interface DictationVoiceOptions {
  deepgramApiKey: string
  onStatusChange:    (status: DictationStatus) => void
  onInterim:         (text: string) => void
  onCommit:          (text: string) => void
  onCommand:         (cmd: DictationCommand) => void
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

const COMMAND_MAP: Record<string, DictationCommand> = {
  'new line':          'new_line',
  'newline':           'new_line',
  'next line':         'new_line',
  'new paragraph':     'new_paragraph',
  'next paragraph':    'new_paragraph',
  'period':            'period',
  'full stop':         'period',
  'comma':             'comma',
  'question mark':     'question_mark',
  'exclamation point': 'exclamation',
  'exclamation mark':  'exclamation',
  'colon':             'colon',
  'semicolon':         'semicolon',
  'semi colon':        'semicolon',
  'delete that':       'delete_word',
  'scratch that':      'delete_word',
  'undo that':         'undo',
  'undo':              'undo',
  'stop dictation':    'stop',
  'stop listening':    'stop',
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/[.,!?;:]+$/, '')
}

export class DictationVoice {
  private socket:     WebSocket | null = null
  private microphone: MediaRecorder | null = null
  private utterance = ''
  private _status: DictationStatus = 'idle'

  constructor(private options: DictationVoiceOptions) {}

  get status(): DictationStatus { return this._status }

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
    this.setStatus('idle')
  }

  private handleTranscript(msg: DGTranscriptMessage): void {
    const transcript = msg.channel.alternatives[0]?.transcript ?? ''

    if (!msg.is_final) {
      this.options.onInterim(this.utterance + transcript)
      return
    }

    this.utterance = (this.utterance + ' ' + transcript).trim()

    if (msg.speech_final) {
      const full = this.utterance
      this.utterance = ''
      if (!full) return

      const cmd = COMMAND_MAP[normalize(full)]
      if (cmd) {
        this.options.onCommand(cmd)
        if (cmd === 'stop') this.disconnect()
        return
      }
      this.options.onCommit(full)
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

  private setStatus(status: DictationStatus): void {
    this._status = status
    this.options.onStatusChange(status)
  }
}
