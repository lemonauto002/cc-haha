import { useCallback, useRef, useState } from 'react'
import { getDesktopHost } from '../lib/desktopHost'
import type { VoiceCredentials } from '../lib/desktopHost/types'
import { useVoiceRecorder } from './useVoiceRecorder'
import { playVoiceChime } from './chime'

export type UseVoiceInputOptions = {
  credentials: VoiceCredentials | null
  /** Called with the recognized text after a successful transcription. */
  onText: (text: string) => void
  onError?: (message: string) => void
}

export type VoiceInput = {
  /** `false` when mic capture or the voice capability is unavailable. */
  supported: boolean
  isRecording: boolean
  isTranscribing: boolean
  error: string | null
  /** Push-to-toggle: starts recording, or stops + transcribes when already recording. */
  toggle: () => Promise<void>
  cancel: () => void
}

export function useVoiceInput({ credentials, onText, onError }: UseVoiceInputOptions): VoiceInput {
  const recorder = useVoiceRecorder()
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [transcribeError, setTranscribeError] = useState<string | null>(null)

  const onTextRef = useRef(onText)
  const onErrorRef = useRef(onError)
  onTextRef.current = onText
  onErrorRef.current = onError

  const host = getDesktopHost()
  const capable = host.capabilities.voice

  const transcribe = useCallback(async () => {
    if (!credentials?.apiKey) {
      const message = 'Volcano API key is not configured.'
      setTranscribeError(message)
      onErrorRef.current?.(message)
      return
    }
    const pcm = await recorder.stop()
    if (pcm.byteLength === 0) return
    setIsTranscribing(true)
    setTranscribeError(null)
    try {
      const result = await host.voice.transcribe({
        apiKey: credentials.apiKey,
        asrResourceId: credentials.asrResourceId,
        pcm,
        sampleRate: 16000,
      })
      const text = result.text.trim()
      if (text) onTextRef.current(text)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Voice recognition failed.'
      setTranscribeError(message)
      onErrorRef.current?.(message)
    } finally {
      setIsTranscribing(false)
    }
  }, [credentials, host, recorder])

  const toggle = useCallback(async () => {
    if (isTranscribing) return
    if (recorder.isRecording) {
      playVoiceChime('end')
      await transcribe()
      return
    }
    setTranscribeError(null)
    await recorder.start()
    playVoiceChime('start')
  }, [isTranscribing, recorder, transcribe])

  const cancel = useCallback(() => {
    recorder.cancel()
    setTranscribeError(null)
  }, [recorder])

  return {
    supported: recorder.supported && capable,
    isRecording: recorder.isRecording,
    isTranscribing,
    error: transcribeError ?? recorder.error,
    toggle,
    cancel,
  }
}
