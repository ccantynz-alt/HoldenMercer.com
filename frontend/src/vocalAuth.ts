/**
 * VocalAuth — energy-profile voice gating.
 *
 * IMPORTANT: This is a lightweight heuristic, NOT a real biometric system.
 * It compares spectral centroid + RMS energy against a stored owner profile.
 * It will not resist a deliberate impersonation attempt.
 * Suitable for: "is this my microphone / is someone else talking?"
 * Not suitable for: security-critical authentication.
 *
 * Flow:
 *   1. enroll(stream, durationMs)  — record owner profile (10s recommended)
 *   2. verify(stream, durationMs)  — compare against profile
 *   3. startContinuous(stream, cb) — real-time gate (calls cb with 'owner'|'other'|'silence')
 *
 * Profile is stored in localStorage under 'sovereign_vocal_profile'.
 */

const STORAGE_KEY = 'sovereign_vocal_profile'
const FFT_SIZE    = 2048
const ENROLL_MS   = 8_000
const VERIFY_MS   = 3_000

// How far the centroid / RMS can deviate before it's considered 'other'
const CENTROID_TOLERANCE = 0.25   // fraction of enrolled centroid
const RMS_TOLERANCE      = 0.50   // fraction of enrolled RMS

export type AuthResult = 'owner' | 'other' | 'silence' | 'no_profile'

export interface VocalProfile {
  centroidMean: number
  centroidStd:  number
  rmsMean:      number
  rmsStd:       number
  enrolledAt:   number
}

// ── Feature extraction ────────────────────────────────────────────────────────

function extractFeatures(analyser: AnalyserNode): { centroid: number; rms: number } {
  const freqData = new Uint8Array(analyser.frequencyBinCount)
  analyser.getByteFrequencyData(freqData)

  let weightedSum = 0
  let totalWeight = 0
  let sumSq = 0

  for (let i = 0; i < freqData.length; i++) {
    const amp = freqData[i]
    weightedSum += i * amp
    totalWeight += amp
    sumSq += (amp / 255) ** 2
  }

  const centroid = totalWeight > 0 ? weightedSum / totalWeight / freqData.length : 0
  const rms = Math.sqrt(sumSq / freqData.length)

  return { centroid, rms }
}

function collectSamples(
  stream: MediaStream,
  durationMs: number,
  intervalMs = 50,
): Promise<Array<{ centroid: number; rms: number }>> {
  return new Promise(resolve => {
    const ctx      = new AudioContext()
    const source   = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = FFT_SIZE
    source.connect(analyser)

    const samples: Array<{ centroid: number; rms: number }> = []
    const id = setInterval(() => {
      samples.push(extractFeatures(analyser))
    }, intervalMs)

    setTimeout(() => {
      clearInterval(id)
      source.disconnect()
      ctx.close()
      resolve(samples.filter(s => s.rms > 0.02))  // discard silence frames
    }, durationMs)
  })
}

function stats(values: number[]): { mean: number; std: number } {
  if (values.length === 0) return { mean: 0, std: 0 }
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const std  = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length)
  return { mean, std }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function enroll(
  stream: MediaStream,
  durationMs: number = ENROLL_MS,
): Promise<VocalProfile> {
  const samples = await collectSamples(stream, durationMs)
  if (samples.length < 5) throw new Error('Not enough voiced frames — speak during enrollment.')

  const profile: VocalProfile = {
    ...stats(samples.map(s => s.centroid)),
    ...{} as object,
    centroidMean: stats(samples.map(s => s.centroid)).mean,
    centroidStd:  stats(samples.map(s => s.centroid)).std,
    rmsMean:      stats(samples.map(s => s.rms)).mean,
    rmsStd:       stats(samples.map(s => s.rms)).std,
    enrolledAt: Date.now(),
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify(profile))
  return profile
}

export function loadProfile(): VocalProfile | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

export function clearProfile(): void {
  localStorage.removeItem(STORAGE_KEY)
}

export async function verify(
  stream: MediaStream,
  durationMs: number = VERIFY_MS,
): Promise<AuthResult> {
  const profile = loadProfile()
  if (!profile) return 'no_profile'

  const samples = await collectSamples(stream, durationMs)
  if (samples.length < 3) return 'silence'

  const { mean: cMean } = stats(samples.map(s => s.centroid))
  const { mean: rMean } = stats(samples.map(s => s.rms))

  const centroidDelta = Math.abs(cMean - profile.centroidMean) / (profile.centroidMean || 1)
  const rmsDelta      = Math.abs(rMean - profile.rmsMean)      / (profile.rmsMean || 1)

  return centroidDelta < CENTROID_TOLERANCE && rmsDelta < RMS_TOLERANCE
    ? 'owner'
    : 'other'
}

// ── Continuous gate ───────────────────────────────────────────────────────────

export class VocalGate {
  private ctx:      AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private source:   MediaStreamAudioSourceNode | null = null
  private interval: ReturnType<typeof setInterval> | null = null
  private profile:  VocalProfile | null = null

  start(
    stream: MediaStream,
    onResult: (result: AuthResult) => void,
    checkIntervalMs = 500,
  ): void {
    this.stop()
    this.profile = loadProfile()

    this.ctx      = new AudioContext()
    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = FFT_SIZE
    this.source   = this.ctx.createMediaStreamSource(stream)
    this.source.connect(this.analyser)

    this.interval = setInterval(() => {
      if (!this.analyser || !this.profile) {
        onResult(this.profile ? 'silence' : 'no_profile')
        return
      }
      const { centroid, rms } = extractFeatures(this.analyser)

      if (rms < 0.02) { onResult('silence'); return }

      const cDelta = Math.abs(centroid - this.profile.centroidMean)
                   / (this.profile.centroidMean || 1)
      const rDelta = Math.abs(rms - this.profile.rmsMean)
                   / (this.profile.rmsMean || 1)

      onResult(
        cDelta < CENTROID_TOLERANCE && rDelta < RMS_TOLERANCE ? 'owner' : 'other'
      )
    }, checkIntervalMs)
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval)
    this.source?.disconnect()
    this.ctx?.close()
    this.ctx = null; this.analyser = null; this.source = null
  }
}
