/**
 * ResizeHandle — vertical drag handle between two panes.
 *
 * Reports the delta from drag-start so the parent can map it to a width
 * (subtract for "right pane that grows leftward", add for the inverse).
 * Captures pointer events so the drag survives even if the cursor leaves
 * the handle. Touch-friendly via pointer events (works on iPad).
 */

import { useCallback, useRef } from 'react'

interface Props {
  /** Called on every pointer move. dx is delta from drag start in CSS pixels. */
  onResize: (dx: number) => void
  /** Optional callback when dragging stops. */
  onResizeEnd?: () => void
}

export function ResizeHandle({ onResize, onResizeEnd }: Props) {
  const startXRef = useRef<number | null>(null)

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    startXRef.current = e.clientX
    const target = e.currentTarget
    target.setPointerCapture(e.pointerId)
  }, [])

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (startXRef.current === null) return
    onResize(e.clientX - startXRef.current)
  }, [onResize])

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (startXRef.current === null) return
    startXRef.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
    onResizeEnd?.()
  }, [onResizeEnd])

  return (
    <div
      className="hm-resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize docked pane"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  )
}
