/**
 * LiquidOrb — GPU-rendered voice-reactive orb.
 *
 * Mounts a WebGL canvas. When a MediaStream is provided (mic open),
 * an AudioAnalyser feeds real-time RMS intensity to u_intensity.
 * The canvas is transparent so it composites over any background.
 */

import { useEffect, useRef } from 'react'
import { OrbRenderer, OrbAudioAnalyser } from '../renderer'
import type { VoiceStatus } from '../services/SovereignVoice'

interface LiquidOrbProps {
  stream:  MediaStream | null
  status:  VoiceStatus
  size?:   number
}

export function LiquidOrb({ stream, status, size = 220 }: LiquidOrbProps) {
  const canvasRef  = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<OrbRenderer | null>(null)
  const analyserRef = useRef<OrbAudioAnalyser | null>(null)

  // Init renderer once on mount
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    try {
      const r = new OrbRenderer(canvas)
      r.resize(size, size)
      r.start()
      rendererRef.current  = r
      analyserRef.current  = new OrbAudioAnalyser(r)
    } catch (err) {
      console.warn('LiquidOrb: WebGL init failed', err)
    }
    return () => {
      rendererRef.current?.stop()
      analyserRef.current?.disconnect()
    }
  }, []) // eslint-disable-line

  // Resize when size prop changes
  useEffect(() => {
    rendererRef.current?.resize(size, size)
  }, [size])

  // Connect / disconnect audio analyser when stream changes
  useEffect(() => {
    const analyser = analyserRef.current
    if (!analyser) return
    if (stream) {
      analyser.connect(stream)
    } else {
      analyser.disconnect()
    }
  }, [stream])

  const isActive = status === 'listening' || status === 'speech_final'

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      style={{
        display:      'block',
        borderRadius: '50%',
        opacity:      status === 'idle' ? 0.35 : 1,
        transition:   'opacity 600ms ease, transform 300ms ease',
        transform:    isActive ? 'scale(1.05)' : 'scale(1)',
        filter:       isActive
          ? 'drop-shadow(0 0 18px #1d4ed8) drop-shadow(0 0 40px #3b82f680)'
          : 'drop-shadow(0 0 6px #1e3a5f)',
      }}
    />
  )
}
