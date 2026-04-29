/**
 * useDictation — Dictation hook for the Sovereign Dashboard.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  PASTE YOUR EXISTING DICTATION LOGIC HERE.
 *
 *  This file ships a working default implementation using the browser's
 *  built-in Web Speech API so the dashboard runs immediately out of the box.
 *
 *  To migrate your own dictation engine (e.g. Whisper, Deepgram, Voxlen):
 *    1. Replace the body of useDictation() below with your code.
 *    2. Keep the returned object shape identical — CommandCenter.jsx
 *       depends on these exact property names.
 *
 *  Required return shape:
 *  {
 *    isListening    : boolean       — true while recording
 *    isSupported    : boolean       — false if browser/device lacks mic access
 *    transcript     : string        — live partial text as it comes in
 *    finalTranscript: string        — committed text ready to send
 *    startListening : () => void
 *    stopListening  : () => void
 *    resetTranscript: () => void    — clears both transcript fields
 *    error          : string|null
 *  }
 * ─────────────────────────────────────────────────────────────────────────
 */

import { useState, useEffect, useRef, useCallback } from 'react'

const SpeechRecognition =
  typeof window !== 'undefined'
    ? window.SpeechRecognition || window.webkitSpeechRecognition
    : null

export function useDictation() {
  const [isListening, setIsListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [finalTranscript, setFinalTranscript] = useState('')
  const [error, setError] = useState(null)
  const recognitionRef = useRef(null)

  const isSupported = Boolean(SpeechRecognition)

  useEffect(() => {
    if (!isSupported) return

    const recognition = new SpeechRecognition()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = 'en-US'

    recognition.onresult = (event) => {
      let interim = ''
      let final = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const text = event.results[i][0].transcript
        if (event.results[i].isFinal) {
          final += text
        } else {
          interim += text
        }
      }
      setTranscript(interim)
      if (final) {
        setFinalTranscript((prev) => (prev + ' ' + final).trim())
      }
    }

    recognition.onerror = (event) => {
      setError(event.error)
      setIsListening(false)
    }

    recognition.onend = () => {
      setIsListening(false)
    }

    recognitionRef.current = recognition

    return () => {
      recognition.abort()
    }
  }, [isSupported])

  const startListening = useCallback(() => {
    if (!isSupported || isListening) return
    setError(null)
    setTranscript('')
    recognitionRef.current?.start()
    setIsListening(true)
  }, [isSupported, isListening])

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop()
    setIsListening(false)
  }, [])

  const resetTranscript = useCallback(() => {
    setTranscript('')
    setFinalTranscript('')
    setError(null)
  }, [])

  return {
    isListening,
    isSupported,
    transcript,
    finalTranscript,
    startListening,
    stopListening,
    resetTranscript,
    error,
  }
}
