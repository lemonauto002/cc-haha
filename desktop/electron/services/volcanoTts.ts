// Volcano TTS orchestration: POSTs text to the unidirectional TTS endpoint and
// reads the newline-delimited JSON stream, accumulating base64 audio chunks
// into a single buffer suitable for `<audio>` playback.
//
// Ported from ~/.voicemode/services/volc-tts/voicemode_volc_proxy.py
// (`_open_stream` / `stream_gen`). Uses the global `fetch` available in the
// Electron main process (Node >= 18).

import type { VoiceSynthesizeInput, VoiceSynthesizeResult } from '../../src/lib/desktopHost/types'
import {
  TTS_DEFAULT_RESOURCE_ID,
  TTS_DEFAULT_SPEAKER,
  TTS_ENDPOINT,
  VolcanoError,
  buildTtsPayload,
  buildWavHeader,
  bufferToArrayBuffer,
  parseTtsLine,
  ttsMediaType,
} from './voiceVolcanoProtocol'

function resolveFormat(format: unknown): 'mp3' | 'pcm' | 'wav' {
  return format === 'pcm' || format === 'wav' ? format : 'mp3'
}

/**
 * Synthesize speech for `text`. Returns audio bytes (mp3 by default) plus the
 * matching MIME type. The renderer plays it via `new Audio(blobUrl).play()`.
 */
export async function synthesizeWithVolcano(input: VoiceSynthesizeInput): Promise<VoiceSynthesizeResult> {
  const apiKey = input.apiKey?.trim()
  if (!apiKey) throw new VolcanoError(-1, 'Volcano API key not configured')

  const text = input.text.trim()
  if (!text) throw new VolcanoError(-1, 'TTS text is empty')

  const resourceId = input.ttsResourceId?.trim() || TTS_DEFAULT_RESOURCE_ID
  const speaker = input.speaker?.trim() || TTS_DEFAULT_SPEAKER
  const format = resolveFormat(input.format)

  const headers: Record<string, string> = {
    'X-Api-Key': apiKey,
    'X-Api-Resource-Id': resourceId,
    'Content-Type': 'application/json',
    Connection: 'keep-alive',
    'X-Control-Require-Usage-Tokens-Return': '*',
  }

  let response: Response
  try {
    response = await fetch(TTS_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildTtsPayload(text, speaker, format)),
    })
  } catch (error) {
    throw new VolcanoError(-1, `network error: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (!response.ok || !response.body) {
    const body = await response.text().catch(() => '')
    throw new VolcanoError(response.status, `HTTP ${response.status}: ${body.slice(0, 300)}`)
  }

  const chunks: Buffer[] = []
  await consumeTtsStream(response.body, line => {
    const result = parseTtsLine(line)
    switch (result.kind) {
      case 'audio':
        chunks.push(result.audio)
        return
      case 'end':
        return 'break'
      case 'error':
        throw new VolcanoError(result.code, 'volcano business error')
      case 'skip':
      default:
        return
    }
  })

  const pcm = Buffer.concat(chunks)
  if (format === 'wav') {
    const wav = Buffer.concat([buildWavHeader(pcm.length, 24000, 1, 16), pcm])
    return { audio: bufferToArrayBuffer(wav), mime: ttsMediaType('wav') }
  }
  return { audio: bufferToArrayBuffer(pcm), mime: ttsMediaType(format) }
}

/** Read a web ReadableStream as newline-delimited text, invoking `onLine` per line. */
async function consumeTtsStream(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void | 'break',
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      let newlineIndex = pending.indexOf('\n')
      while (newlineIndex >= 0) {
        const line = pending.slice(0, newlineIndex).replace(/\r$/, '')
        pending = pending.slice(newlineIndex + 1)
        if (onLine(line) === 'break') return
        newlineIndex = pending.indexOf('\n')
      }
    }
    pending += decoder.decode()
    const tail = pending.replace(/\r$/, '')
    if (tail) onLine(tail)
  } finally {
    reader.releaseLock()
  }
}

/** Whether ASR/TTS are usable given the supplied credentials (instant config check). */
export function volcanoVoiceHealth(input: { apiKey?: string }): { asr: boolean; tts: boolean } {
  const configured = (input.apiKey ?? '').trim().length > 0
  return { asr: configured, tts: configured }
}
