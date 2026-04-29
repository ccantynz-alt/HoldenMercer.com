/**
 * Sovereign Orb — standalone fullscreen entry point.
 * Served at /orb.html — no React, no framework, pure canvas.
 *
 * Layer 0 (z-index 0): WebGL canvas — Liquid Orb shader
 * Layer 1 (z-index 1): Canvas 2D   — Vector HUD (rings + telemetry)
 *
 * Pipeline:
 *   Mic → AudioContext(16 kHz)
 *       ├─ AnalyserNode  → u_intensity → GLSL orb morph
 *       └─ ScriptProcessor → PCMSender → /ws/audio (FastAPI)
 */

import { OrbRenderer, OrbAudioAnalyser, PCMSender } from './renderer'
import { HUDRenderer } from './hud'

const WS_AUDIO = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/audio`
const HEALTH_POLL_MS = 15_000

// ── Layer 0: WebGL orb canvas ─────────────────────────────────────────────────
const orbCanvas = document.getElementById('orb') as HTMLCanvasElement

// ── Layer 1: HUD canvas (created in JS — no HTML markup change) ───────────────
const hudCanvas = document.createElement('canvas')
hudCanvas.style.cssText = [
  'position:fixed', 'inset:0',
  'width:100%',     'height:100%',
  'pointer-events:none',
  'z-index:1',
].join(';')
document.body.appendChild(hudCanvas)

// ── Resize both canvases together ────────────────────────────────────────────
function resize() {
  const w = window.innerWidth  * devicePixelRatio
  const h = window.innerHeight * devicePixelRatio

  orbCanvas.width  = w;  orbCanvas.height  = h
  orbCanvas.style.width  = `${window.innerWidth}px`
  orbCanvas.style.height = `${window.innerHeight}px`

  hudCanvas.width  = w;  hudCanvas.height  = h
  hudCanvas.style.width  = `${window.innerWidth}px`
  hudCanvas.style.height = `${window.innerHeight}px`

  orbRenderer?.resize(w, h)
  hudRenderer?.resize(w, h)
}
window.addEventListener('resize', resize)

// ── Init renderers ────────────────────────────────────────────────────────────
let orbRenderer: OrbRenderer
let hudRenderer: HUDRenderer

try {
  orbRenderer = new OrbRenderer(orbCanvas)
  hudRenderer = new HUDRenderer(hudCanvas)

  resize()         // set correct dimensions before first frame
  orbRenderer.start()
  hudRenderer.start()
} catch (err) {
  console.error('Renderer init failed:', err)
  document.body.style.background = '#0a0a0b'
}

// ── Audio pipeline ────────────────────────────────────────────────────────────
const analyser = new OrbAudioAnalyser(orbRenderer!)
const sender   = new PCMSender()

async function initAudio() {
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, sampleRate: 16_000, echoCancellation: true, noiseSuppression: true },
      video: false,
    })
  } catch {
    console.warn('Mic access denied — orb runs in idle mode')
    return
  }
  analyser.connect(stream)
  sender.connect(stream, WS_AUDIO)
}

initAudio()

// ── Health polling → HUD sync status ─────────────────────────────────────────
async function pollHealth() {
  try {
    const res  = await fetch('/api/health/system')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    hudRenderer?.update({
      sync:     data.gluecron?.ok ? 'ok' : 'err',
      provider: data.voice?.provider ?? 'deepgram',
    })
  } catch {
    hudRenderer?.update({ sync: 'err' })
  }
}

pollHealth()
setInterval(pollHealth, HEALTH_POLL_MS)
