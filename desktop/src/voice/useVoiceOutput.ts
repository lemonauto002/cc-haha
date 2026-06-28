import { useEffect, useRef } from 'react'
import { useChatStore } from '../stores/chatStore'
import { getDesktopHost } from '../lib/desktopHost'
import type { VoiceCredentials } from '../lib/desktopHost/types'
import type { VoiceSpeakMode } from '../types/settings'

export type UseVoiceOutputOptions = {
  sessionId: string | null
  /** Master gate: `voice.ttsEnabled && speakMode !== 'off'`. */
  enabled: boolean
  credentials: VoiceCredentials | null
  speaker: string
  speakMode: VoiceSpeakMode
}

const SHORT_LIMIT = 280
const HARD_CAP = 800

/** Strip code blocks / tables / markdown noise so TTS reads prose, not syntax. */
export function stripCodeBlocks(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/^\s{0,3}\d+\.\s+/gm, '')
    .replace(/\|/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Decide what (if anything) to read aloud for a given assistant message. */
export function prepareSpeechText(content: string, speakMode: VoiceSpeakMode): string | null {
  if (speakMode === 'off') return null
  const cleaned = stripCodeBlocks(content)
  if (!cleaned) return null
  if (speakMode === 'shortOnly') {
    return cleaned.length <= SHORT_LIMIT ? cleaned : null
  }
  if (cleaned.length <= HARD_CAP) return cleaned
  return `${cleaned.slice(0, HARD_CAP)}。详细内容请查看对话。`
}

type MessageLike = { type: string; content?: unknown }

function lastAssistantText(messages: ReadonlyArray<MessageLike | undefined> | undefined): string {
  if (!messages) return ''
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message && message.type === 'assistant_text' && typeof message.content === 'string') {
      return message.content
    }
  }
  return ''
}

/**
 * Speak the active session's assistant responses aloud on turn end.
 *
 * Session isolation: the subscription is scoped to `sessionId`. Switching
 * sessions cancels any in-flight synthesis/playback for the previous session,
 * and a session's pre-existing last message is never spoken on switch — only
 * completions that happen while that session is active.
 */
export function useVoiceOutput({
  sessionId,
  enabled,
  credentials,
  speaker,
  speakMode,
}: UseVoiceOutputOptions): void {
  const optsRef = useRef({ enabled, credentials, speaker, speakMode })
  optsRef.current = { enabled, credentials, speaker, speakMode }

  useEffect(() => {
    if (!sessionId) return

    let cancelled = false
    let activeAudio: HTMLAudioElement | null = null
    let prevState = useChatStore.getState().sessions[sessionId]?.chatState ?? 'idle'
    // Seed with the current last assistant text so we only speak NEW turn
    // completions — not whatever was already there when we switched here.
    let lastSpoken = lastAssistantText(useChatStore.getState().sessions[sessionId]?.messages)

    const unsubscribe = useChatStore.subscribe(state => {
      if (cancelled) return
      const session = state.sessions[sessionId]
      if (!session) return
      const nextState = session.chatState
      const wasRunning = prevState !== 'idle'
      prevState = nextState
      if (!wasRunning || nextState !== 'idle') return

      const opts = optsRef.current
      if (!opts.enabled || opts.speakMode === 'off' || !opts.credentials?.apiKey) return

      const text = lastAssistantText(session.messages)
      if (!text || text === lastSpoken) return
      const speech = prepareSpeechText(text, opts.speakMode)
      if (!speech) return
      lastSpoken = text

      // Interrupt anything still playing from a previous turn.
      activeAudio?.pause()

      const credentials = opts.credentials
      void (async () => {
        const host = getDesktopHost()
        if (!host.capabilities.voice || cancelled) return
        try {
          const { audio, mime } = await host.voice.synthesize({
            apiKey: credentials.apiKey,
            ttsResourceId: credentials.ttsResourceId,
            text: speech,
            speaker: opts.speaker,
            format: 'mp3',
          })
          if (cancelled) return
          const blob = new Blob([audio], { type: mime })
          const url = URL.createObjectURL(blob)
          const audioEl = new Audio(url)
          activeAudio = audioEl
          audioEl.onended = () => {
            URL.revokeObjectURL(url)
            if (activeAudio === audioEl) activeAudio = null
          }
          await audioEl.play()
        } catch {
          // TTS failures must never disrupt the chat flow.
        }
      })()
    })

    return () => {
      // Switching sessions: cancel in-flight synthesis and stop playback so the
      // previous session's audio never bleeds into the newly active one.
      cancelled = true
      unsubscribe()
      activeAudio?.pause()
      activeAudio = null
    }
  }, [sessionId])
}
