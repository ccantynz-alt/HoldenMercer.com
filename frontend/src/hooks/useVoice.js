/**
 * useVoice — Audio recording hook for the Sovereign Dashboard.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  PASTE YOUR EXISTING DICTATION CODE HERE.
 *
 *  This file ships a complete working implementation using the browser's
 *  MediaRecorder API. Audio is captured as a blob and sent to the backend
 *  POST /api/refine-dictation → Whisper → Haiku 4.5 → refined intent.
 *
 *  To migrate your own engine (Deepgram, Voxlen, custom Whisper, etc.):
 *    1. Replace the body of useVoice() below with your code.
 *    2. Keep the returned object shape IDENTICAL — CommandCenter.jsx depends
 *       on these exact names.
 *    3. Call onRefined(result) when you have a refined result from the backend.
 *       result shape: { transcript, refined_text, intent, mcp_refs,
 *                       execution_keyword, task_complexity }
 *
 *  Required return shape:
 *  {
 *    isRecording    : boolean        — true while mic is open
 *    isProcessing   : boolean        — true while waiting for Whisper/Haiku
 *    liveTranscript : string         — optional interim text (e.g. from
 *                                      browser SpeechRecognition if you use it)
 *    startRecording : () => void
 *    stopRecording  : () => void     — captures blob, sends to backend
 *    cancelRecording: () => void     — discard without sending
 *    error          : string | null
 *  }
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useState, useRef, useCallback } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { useSovereignAPI } from './useSovereignAPI'

export function useVoice({ onRefined, onTranscript } = {}) {
  const [isRecording, setIsRecording] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [liveTranscript, setLiveTranscript] = useState('')
  const [error, setError] = useState(null)

  const mediaRecorderRef = useRef(null)
  const chunksRef = useRef([])
  const sessionIdRef = useRef(null)

  const { refineAudio } = useSovereignAPI()

  // ── Start recording ────────────────────────────────────────────────────────
  const startRecording = useCallback(async () => {
    setError(null)
    setLiveTranscript('')
    chunksRef.current = []
    sessionIdRef.current = uuidv4()

    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (err) {
      setError('Microphone access denied. Check browser permissions.')
      return
    }

    // Pick the best supported format
    const mimeType = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
    ].find((m) => MediaRecorder.isTypeSupported(m)) || ''

    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {})

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data)
    }

    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop())

      const blob = new Blob(chunksRef.current, {
        type: recorder.mimeType || 'audio/webm',
      })
      chunksRef.current = []

      if (blob.size < 1000) {
        // Too small to be real audio — ignore
        setIsProcessing(false)
        return
      }

      setIsProcessing(true)
      try {
        const result = await refineAudio(blob, sessionIdRef.current)
        if (result) {
          if (onTranscript) onTranscript(result.transcript)
          if (onRefined) onRefined(result)
        }
      } catch (err) {
        setError(err.message || 'Failed to process audio.')
      } finally {
        setIsProcessing(false)
        setLiveTranscript('')
      }
    }

    recorder.onerror = (e) => {
      setError(`Recording error: ${e.error?.message || 'unknown'}`)
      setIsRecording(false)
    }

    // Collect data in 250ms chunks for lower latency on stop
    recorder.start(250)
    mediaRecorderRef.current = recorder
    setIsRecording(true)
  }, [refineAudio, onRefined, onTranscript])

  // ── Stop and process ───────────────────────────────────────────────────────
  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop()
    }
    setIsRecording(false)
  }, [])

  // ── Cancel without sending ─────────────────────────────────────────────────
  const cancelRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.ondataavailable = null
      mediaRecorderRef.current.onstop = null
      mediaRecorderRef.current.stream?.getTracks().forEach((t) => t.stop())
      mediaRecorderRef.current.stop()
    }
    chunksRef.current = []
    setIsRecording(false)
    setIsProcessing(false)
    setLiveTranscript('')
  }, [])

  return {
    isRecording,
    isProcessing,
    liveTranscript,
    startRecording,
    stopRecording,
    cancelRecording,
    error,
  }
}
