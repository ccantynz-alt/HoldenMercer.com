/**
 * Sovereign Vector HUD — Canvas 2D telemetry overlay.
 *
 * Rendered on a separate canvas element layered over the WebGL orb
 * (pointer-events: none, z-index: 1).  Everything is drawn with Canvas 2D
 * primitives at the monitor's native refresh rate — no HTML, no DOM divs.
 *
 * Three status rings orbit the orb:
 *   Ring 1 (inner)  — FPS         : 0–120,  electric green
 *   Ring 2 (middle) — JS Heap     : 0–100%, electric blue
 *   Ring 3 (outer)  — Sync status : orbiting dot, green/red/grey
 *
 * The orb radius in canvas pixels = 0.40 × min(w, h), matching the
 * GLSL smoothstep(0.42, 0.36, d) edge in renderer.ts.
 */

export type SyncStatus = 'ok' | 'err' | 'unknown'

const FONT        = `"JetBrains Mono", "Fira Code", monospace`
const TAU         = Math.PI * 2
const RING_START  = -Math.PI / 2   // 12 o'clock

// Gap between orb edge and first ring (logical pixels before DPR scaling)
const RING_GAP    = 14
const RING_STEP   = 18   // spacing between consecutive rings

interface HUDData {
  fps:        number
  heapMB:     number
  heapLimitMB: number
  sync:       SyncStatus
  provider:   string
}

// ── HUDRenderer ──────────────────────────────────────────────────────────────

export class HUDRenderer {
  private ctx:        CanvasRenderingContext2D
  private raf:        number = 0
  private lastNow:    number = 0
  private fpsSmooth:  number = 0

  // Data injected by the host (orb.ts)
  private data: HUDData = {
    fps: 0, heapMB: 0, heapLimitMB: 512,
    sync: 'unknown', provider: 'deepgram',
  }

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D not supported')
    this.ctx = ctx
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  update(patch: Partial<HUDData>): void {
    Object.assign(this.data, patch)
  }

  start(): void {
    this.lastNow = performance.now()
    this.raf = requestAnimationFrame(this._frame)
  }

  stop(): void {
    cancelAnimationFrame(this.raf)
  }

  resize(w: number, h: number): void {
    this.canvas.width  = w
    this.canvas.height = h
  }

  // ── Frame loop ─────────────────────────────────────────────────────────────

  private _frame = (now: number): void => {
    // Smooth FPS with exponential moving average
    const delta = now - this.lastNow
    if (delta > 0) {
      const raw = 1000 / delta
      this.fpsSmooth = this.fpsSmooth === 0
        ? raw
        : this.fpsSmooth * 0.9 + raw * 0.1
    }
    this.lastNow = now

    // Pull live heap data (Chromium only — graceful fallback)
    const mem = (performance as Performance & { memory?: {
      usedJSHeapSize: number; jsHeapSizeLimit: number
    }}).memory
    if (mem) {
      this.data.heapMB      = mem.usedJSHeapSize  / 1_048_576
      this.data.heapLimitMB = mem.jsHeapSizeLimit / 1_048_576
    }

    this._draw(now)
    this.raf = requestAnimationFrame(this._frame)
  }

  // ── Draw ───────────────────────────────────────────────────────────────────

  private _draw(now: number): void {
    const { ctx, canvas } = this
    const { width: w, height: h } = canvas
    const dpr = window.devicePixelRatio || 1
    const cx  = w / 2
    const cy  = h / 2
    const t   = now / 1000

    // The orb edge is at d=0.40 in normalised coords:
    //   uv = (gl_FragCoord - 0.5*res) / min(res.y, res.x)
    //   d  = length(uv) ≈ 0.40  → pixel_radius = 0.40 * min(w,h)
    const orbR = 0.40 * Math.min(w, h)

    ctx.clearRect(0, 0, w, h)

    const r1 = orbR + (RING_GAP)          * dpr
    const r2 = orbR + (RING_GAP + RING_STEP)     * dpr
    const r3 = orbR + (RING_GAP + RING_STEP * 2) * dpr

    const fps   = Math.min(this.fpsSmooth, 120)
    const heap  = this.data.heapLimitMB > 0
      ? Math.min(this.data.heapMB / this.data.heapLimitMB, 1)
      : 0

    // ── Ring 1: FPS ──────────────────────────────────────────────────────────
    const fpsColor = fps < 50 ? '#f59e0b' : fps < 90 ? '#60a5fa' : '#00ff88'
    this._arcTrack(cx, cy, r1, 1.2 * dpr)
    this._arcFill(cx, cy, r1, fps / 120, fpsColor, 1.2 * dpr)

    // ── Ring 2: JS Heap ──────────────────────────────────────────────────────
    const heapColor = heap > 0.85 ? '#ef4444' : heap > 0.6 ? '#f59e0b' : '#60a5fa'
    this._arcTrack(cx, cy, r2, 1.0 * dpr)
    this._arcFill(cx, cy, r2, heap, heapColor, 1.0 * dpr)

    // ── Ring 3: Sync orbiting dot ────────────────────────────────────────────
    const syncColor = this.data.sync === 'ok'  ? '#00ff88'
                    : this.data.sync === 'err' ? '#ef4444'
                    : '#4b5563'
    this._arcTrack(cx, cy, r3, 0.8 * dpr)
    this._syncDot(cx, cy, r3, t, syncColor)

    // ── Corner labels ────────────────────────────────────────────────────────
    this._labels(cx, cy, r3, fps, heap, dpr)
  }

  // ── Primitives ─────────────────────────────────────────────────────────────

  private _arcTrack(cx: number, cy: number, r: number, lw: number): void {
    const ctx = this.ctx
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, TAU)
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'
    ctx.lineWidth = lw
    ctx.stroke()
  }

  private _arcFill(
    cx: number, cy: number, r: number,
    fill: number, color: string, lw: number,
  ): void {
    if (fill <= 0) return
    const ctx = this.ctx
    const end = RING_START + TAU * Math.max(0, Math.min(1, fill))
    ctx.beginPath()
    ctx.arc(cx, cy, r, RING_START, end)
    ctx.strokeStyle = color
    ctx.lineWidth = lw
    ctx.lineCap = 'round'
    ctx.shadowColor = color
    ctx.shadowBlur = 6
    ctx.stroke()
    ctx.shadowBlur = 0
  }

  private _syncDot(
    cx: number, cy: number, r: number,
    t: number, color: string,
  ): void {
    const ctx = this.ctx
    const angle = t * 0.7 + RING_START
    const dx = cx + Math.cos(angle) * r
    const dy = cy + Math.sin(angle) * r
    const dpr = window.devicePixelRatio || 1

    ctx.beginPath()
    ctx.arc(dx, dy, 2.5 * dpr, 0, TAU)
    ctx.fillStyle = color
    ctx.shadowColor = color
    ctx.shadowBlur = 12
    ctx.fill()
    ctx.shadowBlur = 0

    // Short trailing arc for motion blur feel
    const trailEnd   = angle
    const trailStart = angle - 0.35
    ctx.beginPath()
    ctx.arc(cx, cy, r, trailStart, trailEnd)
    ctx.strokeStyle = color.replace(')', ', 0.25)').replace('rgb(', 'rgba(').replace('#', 'rgba(').replace('rgba(', 'rgba(')
    // simpler: just use low-opacity version
    ctx.strokeStyle = color + '40'
    ctx.lineWidth = 1.5 * dpr
    ctx.lineCap = 'round'
    ctx.stroke()
  }

  private _labels(
    cx: number, cy: number,
    outerR: number,
    fps: number,
    heap: number,
    dpr: number,
  ): void {
    const ctx = this.ctx
    const fs  = 10 * dpr
    ctx.font = `${fs}px ${FONT}`
    ctx.textBaseline = 'top'

    const rows: Array<{ label: string; value: string; color: string }> = [
      {
        label: 'FPS',
        value: Math.round(fps).toString().padStart(3, ' '),
        color: fps < 50 ? '#f59e0b' : '#94a3b8',
      },
      {
        label: 'MEM',
        value: this.data.heapMB > 0
          ? `${Math.round(this.data.heapMB)}MB`
          : '—',
        color: heap > 0.85 ? '#ef4444' : '#94a3b8',
      },
      {
        label: 'SYNC',
        value: this.data.sync.toUpperCase(),
        color: this.data.sync === 'ok' ? '#00ff88'
             : this.data.sync === 'err' ? '#ef4444'
             : '#4b5563',
      },
      {
        label: 'VIA',
        value: this.data.provider.toUpperCase().slice(0, 8),
        color: '#4b5563',
      },
    ]

    const lineH = (fs + 4 * dpr)
    const totalH = rows.length * lineH
    const textX = cx + outerR + 16 * dpr
    const textY = cy - totalH / 2

    rows.forEach(({ label, value, color }, i) => {
      const y = textY + i * lineH
      ctx.fillStyle = 'rgba(71,85,105,0.7)'
      ctx.fillText(`${label}  `, textX, y)
      ctx.fillStyle = color
      const labelW = ctx.measureText(`${label}  `).width
      ctx.fillText(value, textX + labelW, y)
    })
  }
}
