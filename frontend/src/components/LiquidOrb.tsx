/**
 * LiquidOrb — GPU-rendered status orb.
 *
 * Mounts a WebGL canvas. Caller passes a status string and optional intensity
 * (0–1) which drives the shader's halo and pulse. Used as a build/agent
 * activity indicator throughout the dashboard.
 */

import { useEffect, useRef } from 'react'
import { OrbRenderer } from '../renderer'

export type OrbStatus = 'idle' | 'active' | 'busy'

interface LiquidOrbProps {
  status:    OrbStatus
  intensity?: number   // 0–1, optional driver. Defaults to 0 idle / 0.6 active / 1 busy.
  size?:     number
}

const DEFAULT_INTENSITY: Record<OrbStatus, number> = {
  idle:   0,
  active: 0.6,
  busy:   1,
}

export function LiquidOrb({ status, intensity, size = 220 }: LiquidOrbProps) {
  const canvasRef   = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<OrbRenderer | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    try {
      const r = new OrbRenderer(canvas)
      r.resize(size, size)
      r.start()
      rendererRef.current = r
    } catch (err) {
      console.warn('LiquidOrb: WebGL init failed', err)
    }
    return () => { rendererRef.current?.stop() }
  }, []) // eslint-disable-line

  useEffect(() => {
    rendererRef.current?.resize(size, size)
  }, [size])

  useEffect(() => {
    const value = intensity ?? DEFAULT_INTENSITY[status]
    rendererRef.current?.setIntensity(value)
  }, [status, intensity])

  const isActive = status !== 'idle'

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      style={{
        display:      'block',
        borderRadius: '50%',
        opacity:      status === 'idle' ? 0.45 : 1,
        transition:   'opacity 600ms ease, transform 300ms ease',
        transform:    isActive ? 'scale(1.05)' : 'scale(1)',
        filter:       isActive
          ? 'drop-shadow(0 0 18px #c9a961) drop-shadow(0 0 40px #c9a96180)'
          : 'drop-shadow(0 0 6px #c9a96155)',
      }}
    />
  )
}
