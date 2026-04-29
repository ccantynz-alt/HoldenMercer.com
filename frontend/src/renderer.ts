/**
 * Sovereign Engine — Liquid Orb WebGL Renderer
 *
 * Compiles the fragment shader, drives the animation loop at the monitor's
 * native refresh rate (requestAnimationFrame), and exposes an intensity
 * setter so callers can feed real-time PCM/RMS data from the mic.
 *
 * Usage:
 *   const orb = new OrbRenderer(canvas)
 *   orb.start()
 *   orb.setIntensity(0.8)   // called from AudioAnalyser on each frame
 *   orb.stop()
 */

// ── Vertex shader — fullscreen quad passthrough ───────────────────────────────
const VERTEX_SRC = /* glsl */`
  attribute vec2 a_position;
  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`

// ── Fragment shader — Sovereign Liquid Orb v1.0 ───────────────────────────────
// Original by user; fixed:
//   • Division guard: max(d, 1e-4) prevents NaN / infinity at center pixel
//   • Idle pulse: when u_intensity < 0.01, a gentle heartbeat keeps the orb alive
const FRAGMENT_SRC = /* glsl */`
  precision highp float;

  uniform float u_time;
  uniform float u_intensity;
  uniform vec2  u_resolution;

  void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy)
              / min(u_resolution.y, u_resolution.x);

    // Idle heartbeat — keeps the orb breathing when no voice is detected
    float idle_pulse = sin(u_time * 1.4) * 0.015;
    float intensity  = max(u_intensity, 0.01) + idle_pulse;

    // Layered sine-wave displacement keyed to audio intensity
    float d = length(uv);
    float noise = sin(d * 10.0 - u_time * 2.0 + intensity * 5.0) * 0.1;
    d += noise;

    // Color: Sovereign deep black → electric blue, shifted by voice
    vec3 color = vec3(0.02, 0.05, 0.1) / max(d, 1e-4);
    color *= vec3(intensity * 0.5, 0.8, 1.0);

    // Sharp disc with soft glow falloff
    float mask = smoothstep(0.42, 0.36, d);
    color *= mask;

    gl_FragColor = vec4(color, mask);
  }
`

// ── Fullscreen quad vertices ──────────────────────────────────────────────────
const QUAD = new Float32Array([-1, -1,  1, -1, -1,  1,  -1,  1,  1, -1,  1,  1])

// ── Renderer class ────────────────────────────────────────────────────────────

const TARGET_FPS     = 120
const FRAME_BUDGET   = 1000 / TARGET_FPS   // ~8.33 ms

export class OrbRenderer {
  private gl:        WebGLRenderingContext
  private program:   WebGLProgram
  private buf:       WebGLBuffer
  private uTime:     WebGLUniformLocation
  private uIntensity:WebGLUniformLocation
  private uRes:      WebGLUniformLocation
  private raf:       number = 0
  private startTime: number = performance.now()
  private lastFrame: number = 0
  private _intensity: number = 0
  private _posLoc:   number = -1

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false })
    if (!gl) throw new Error('WebGL not supported')
    this.gl = gl

    this.program    = this._compile(VERTEX_SRC, FRAGMENT_SRC)
    this.buf        = this._quad()
    this.uTime      = gl.getUniformLocation(this.program, 'u_time')!
    this.uIntensity = gl.getUniformLocation(this.program, 'u_intensity')!
    this.uRes       = gl.getUniformLocation(this.program, 'u_resolution')!

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

    // Cache attribute location — avoid per-frame getAttribLocation lookups
    this._posLoc = gl.getAttribLocation(this.program, 'a_position')
    gl.enableVertexAttribArray(this._posLoc)
  }

  /** Feed real-time RMS intensity (0.0 – 1.0) from the AudioAnalyser. */
  setIntensity(value: number): void {
    this._intensity = Math.max(0, Math.min(1, value))
  }

  start(): void {
    this.startTime = performance.now()
    this._frame()
  }

  stop(): void {
    cancelAnimationFrame(this.raf)
  }

  resize(w: number, h: number): void {
    this.canvas.width  = w
    this.canvas.height = h
    this.gl.viewport(0, 0, w, h)
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _frame = (now: number): void => {
    // 120 FPS cap — skip render if we're ahead of schedule
    if (now - this.lastFrame < FRAME_BUDGET) {
      this.raf = requestAnimationFrame(this._frame)
      return
    }
    this.lastFrame = now

    const gl      = this.gl
    const elapsed = (now - this.startTime) / 1000

    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)

    gl.useProgram(this.program)
    gl.uniform1f(this.uTime, elapsed)
    gl.uniform1f(this.uIntensity, this._intensity)
    gl.uniform2f(this.uRes, this.canvas.width, this.canvas.height)

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf)
    gl.vertexAttribPointer(this._posLoc, 2, gl.FLOAT, false, 0, 0)
    gl.drawArrays(gl.TRIANGLES, 0, 6)

    this.raf = requestAnimationFrame(this._frame)
  }

  private _compile(vsSrc: string, fsSrc: string): WebGLProgram {
    const gl = this.gl
    const vs = this._shader(gl.VERTEX_SHADER, vsSrc)
    const fs = this._shader(gl.FRAGMENT_SHADER, fsSrc)
    const prog = gl.createProgram()!
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`Shader link failed: ${gl.getProgramInfoLog(prog)}`)
    }
    return prog
  }

  private _shader(type: number, src: string): WebGLShader {
    const gl     = this.gl
    const shader = gl.createShader(type)!
    gl.shaderSource(shader, src)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`Shader compile error: ${gl.getShaderInfoLog(shader)}`)
    }
    return shader
  }

  private _quad(): WebGLBuffer {
    const gl  = this.gl
    const buf = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW)
    return buf
  }
}

// ── AudioAnalyser — bridges MediaStream PCM data to OrbRenderer intensity ────

export class OrbAudioAnalyser {
  private ctx:      AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private source:   MediaStreamAudioSourceNode | null = null
  private data:     Uint8Array = new Uint8Array(0)
  private raf:      number = 0

  constructor(private renderer: OrbRenderer) {}

  connect(stream: MediaStream): void {
    this.disconnect()
    this.ctx      = new AudioContext()
    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = 256
    this.data = new Uint8Array(this.analyser.frequencyBinCount)

    this.source = this.ctx.createMediaStreamSource(stream)
    this.source.connect(this.analyser)
    // Do NOT connect to ctx.destination — we don't want mic playback

    this._tick()
  }

  disconnect(): void {
    cancelAnimationFrame(this.raf)
    this.source?.disconnect()
    this.ctx?.close()
    this.ctx      = null
    this.analyser = null
    this.source   = null
    this.renderer.setIntensity(0)
  }

  private _tick = (): void => {
    if (!this.analyser) return
    this.analyser.getByteFrequencyData(this.data)

    // RMS across all frequency bins → 0.0 – 1.0
    let sum = 0
    for (let i = 0; i < this.data.length; i++) sum += this.data[i] ** 2
    const rms = Math.sqrt(sum / this.data.length) / 255

    // Boost so quiet speech still erupts the orb
    this.renderer.setIntensity(Math.min(rms * 2.5, 1.0))

    this.raf = requestAnimationFrame(this._tick)
  }
}

// ── PCMSender — streams raw 16-bit PCM to the FastAPI WebSocket endpoint ─────
//
// AudioContext is resampled to 16 kHz (optimal for speech models).
// ScriptProcessorNode is used for broad browser support; it runs on the
// audio thread and sends Int16 frames the moment they fill (4096 samples
// = 256ms at 16 kHz — low enough for real-time, safe against WS backpressure).
//
// FastAPI endpoint: /ws/audio  (see api/ws_audio.py)

export class PCMSender {
  private ws:        WebSocket | null = null
  private ctx:       AudioContext | null = null
  private source:    MediaStreamAudioSourceNode | null = null
  private processor: ScriptProcessorNode | null = null

  connect(stream: MediaStream, wsUrl: string): void {
    this.disconnect()

    this.ws = new WebSocket(wsUrl)
    this.ws.binaryType = 'arraybuffer'

    // Resample to 16 kHz — ideal for Deepgram / Whisper / CronTech voice
    this.ctx    = new AudioContext({ sampleRate: 16_000 })
    this.source = this.ctx.createMediaStreamSource(stream)

    // Buffer: 4096 samples at 16 kHz = 256ms per chunk
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1)
    this.processor.onaudioprocess = (e: AudioProcessingEvent) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return
      const f32  = e.inputBuffer.getChannelData(0)
      const i16  = new Int16Array(f32.length)
      for (let i = 0; i < f32.length; i++) {
        i16[i] = Math.max(-32768, Math.min(32767, f32[i] * 32768))
      }
      this.ws.send(i16.buffer)
    }

    // Must connect processor into the graph even without monitoring output
    this.source.connect(this.processor)
    this.processor.connect(this.ctx.destination)
  }

  disconnect(): void {
    this.processor?.disconnect()
    this.source?.disconnect()
    this.ctx?.close()
    this.ws?.close()
    this.ws = null; this.ctx = null; this.source = null; this.processor = null
  }

  get readyState(): number {
    return this.ws?.readyState ?? WebSocket.CLOSED
  }
}
