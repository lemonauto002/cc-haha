import { useCallback, useEffect, useRef, useState } from 'react'

// Target format required by Volcano ASR: 16kHz / mono / 16-bit little-endian PCM.
const TARGET_SAMPLE_RATE = 16000
// ScriptProcessor buffer (samples per channel). Deprecated but reliable across
// Vite/Electron builds; avoids AudioWorklet bundling complexity. Swap to an
// AudioWorklet later without touching the rest of the pipeline.
const PROCESSOR_BUFFER = 4096

function floatSampleToInt16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample))
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
}

/** Linear downsample a Float32 PCM channel to a 16kHz Int16 array. */
function toInt16Pcm(input: Float32Array, inputRate: number): Int16Array {
  if (inputRate === TARGET_SAMPLE_RATE) {
    const out = new Int16Array(input.length)
    for (let i = 0; i < input.length; i += 1) {
      const sample = input[i]
      if (sample !== undefined) out[i] = floatSampleToInt16(sample)
    }
    return out
  }
  const ratio = inputRate / TARGET_SAMPLE_RATE
  const outLength = Math.max(1, Math.floor(input.length / ratio))
  const out = new Int16Array(outLength)
  for (let i = 0; i < outLength; i += 1) {
    const srcIndex = i * ratio
    const lo = Math.floor(srcIndex)
    const hi = Math.min(lo + 1, input.length - 1)
    const low = input[lo]
    const high = input[hi]
    if (low === undefined || high === undefined) continue
    const frac = srcIndex - lo
    out[i] = floatSampleToInt16(low * (1 - frac) + high * frac)
  }
  return out
}

export type VoiceRecorder = {
  /** `false` when the runtime cannot capture microphone audio at all. */
  supported: boolean
  isRecording: boolean
  error: string | null
  start: () => Promise<void>
  /** Stop and resolve to the captured 16kHz/mono/16-bit PCM bytes. */
  stop: () => Promise<ArrayBuffer>
  /** Stop without producing audio. */
  cancel: () => void
}

export function useVoiceRecorder(): VoiceRecorder {
  const [isRecording, setIsRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const streamRef = useRef<MediaStream | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const chunksRef = useRef<Int16Array[]>([])

  const supported = typeof window !== 'undefined'
    && typeof navigator !== 'undefined'
    && !!navigator.mediaDevices
    && typeof navigator.mediaDevices.getUserMedia === 'function'
    && (typeof window.AudioContext !== 'undefined'
      || typeof (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext !== 'undefined')

  const teardown = useCallback(() => {
    processorRef.current?.disconnect()
    sourceRef.current?.disconnect()
    processorRef.current = null
    sourceRef.current = null
    streamRef.current?.getTracks().forEach(track => track.stop())
    streamRef.current = null
    contextRef.current?.close().catch(() => undefined)
    contextRef.current = null
  }, [])

  const start = useCallback(async () => {
    if (!supported) {
      setError('Microphone capture is not supported in this runtime.')
      return
    }
    setError(null)
    chunksRef.current = []
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      streamRef.current = stream
      const webkit = (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      const Ctor = window.AudioContext ?? webkit
      if (!Ctor) {
        throw new Error('AudioContext is not supported in this runtime.')
      }
      const context = new Ctor({ sampleRate: TARGET_SAMPLE_RATE })
      contextRef.current = context
      const source = context.createMediaStreamSource(stream)
      sourceRef.current = source
      const processor = context.createScriptProcessor(PROCESSOR_BUFFER, 1, 1)
      processorRef.current = processor
      processor.onaudioprocess = event => {
        const input = event.inputBuffer.getChannelData(0)
        const pcm = toInt16Pcm(input, context.sampleRate)
        if (pcm.length > 0) chunksRef.current.push(pcm)
      }
      // Connect through a zero-gain node so the processor fires without routing
      // the microphone back to the speakers (feedback).
      const silentGain = context.createGain()
      silentGain.gain.value = 0
      source.connect(processor)
      processor.connect(silentGain)
      silentGain.connect(context.destination)
      setIsRecording(true)
    } catch (err) {
      teardown()
      setIsRecording(false)
      if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
        setError('Microphone permission denied. Grant access in System Settings and retry.')
      } else {
        setError(err instanceof Error ? err.message : 'Failed to start microphone capture.')
      }
    }
  }, [supported, teardown])

  const stop = useCallback(async () => {
    const chunks = chunksRef.current
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    teardown()
    chunksRef.current = []
    setIsRecording(false)
    const merged = new Int16Array(total)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.length
    }
    return merged.buffer
  }, [teardown])

  const cancel = useCallback(() => {
    chunksRef.current = []
    teardown()
    setIsRecording(false)
  }, [teardown])

  useEffect(() => () => teardown(), [teardown])

  return { supported, isRecording, error, start, stop, cancel }
}
