// Volcano ASR orchestration: opens a WebSocket to the bigmodel_nostream
// endpoint with custom auth headers, streams the PCM audio using the binary
// framing protocol, and returns the recognized text.
//
// This MUST run in the Electron main process: browser / Electron-renderer
// `WebSocket` cannot set custom HTTP headers, and Volcano ASR authenticates
// entirely through the WS handshake headers (X-Api-Key etc.).
//
// Ported from ~/.voicemode/services/volc-asr/voicemode_volc_asr_proxy.py (`transcribe`).

import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import type { VoiceTranscribeInput, VoiceTranscribeResult } from '../../src/lib/desktopHost/types'
import {
  ASR_DEFAULT_RESOURCE_ID,
  ASR_ENDPOINT,
  ASR_SAMPLE_RATE,
  ASR_SEGMENT_MS,
  VolcanoError,
  asrSegmentSize,
  buildAudioRequest,
  buildFullRequest,
  buildWavHeader,
  parseResponse,
  splitSegments,
} from './voiceVolcanoProtocol'

const CONNECT_TIMEOUT_MS = 10_000
const TOTAL_TIMEOUT_MS = 60_000

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Transcribe raw 16kHz/mono/16-bit PCM via Volcano ASR.
 *
 * The renderer sends raw PCM (no WAV container); we wrap it in a WAV header so
 * the wire format matches the Python reference (which sends a full WAV). The
 * audio is gzip-framed into ~200ms segments with a negative-sequence terminal
 * packet, sent with a 200ms cadence to avoid server-side rate limiting.
 */
export async function transcribeWithVolcano(input: VoiceTranscribeInput): Promise<VoiceTranscribeResult> {
  const apiKey = input.apiKey?.trim()
  if (!apiKey) throw new VolcanoError(-1, 'Volcano API key not configured')

  const resourceId = input.asrResourceId?.trim() || ASR_DEFAULT_RESOURCE_ID
  const sampleRate = input.sampleRate ?? ASR_SAMPLE_RATE

  const pcm = Buffer.from(input.pcm)
  if (pcm.length === 0) return { text: '' }

  // Wrap raw PCM in a WAV container to match the `audio.format: wav` config.
  const wav = Buffer.concat([buildWavHeader(pcm.length, sampleRate, 1, 16), pcm])
  const segments = splitSegments(wav, asrSegmentSize(sampleRate, ASR_SEGMENT_MS))
  if (segments.length === 0) return { text: '' }

  const requestId = randomUUID()
  const headers = {
    'X-Api-Key': apiKey,
    'X-Api-Resource-Id': resourceId,
    'X-Api-Request-Id': requestId,
    'X-Api-Connect-Id': requestId,
    'X-Api-Sequence': '-1',
  }

  return await new Promise<VoiceTranscribeResult>((resolve, reject) => {
    const textParts: string[] = []
    let seq = 1
    let settled = false
    let totalTimer: NodeJS.Timeout | undefined

    const finish = (error: Error | null) => {
      if (settled) return
      settled = true
      if (totalTimer) clearTimeout(totalTimer)
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      if (error) reject(error)
      else resolve({ text: textParts.join('').trim() })
    }

    totalTimer = setTimeout(
      () => finish(new VolcanoError(-1, 'ASR timeout')),
      TOTAL_TIMEOUT_MS,
    )

    const ws = new WebSocket(ASR_ENDPOINT, { headers, handshakeTimeout: CONNECT_TIMEOUT_MS })
    ws.binaryType = 'nodebuffer'

    ws.on('open', async () => {
      try {
        // 1) Full config request.
        ws.send(buildFullRequest(seq))
        seq += 1
        // 2) Audio segments (last packet carries a negative sequence number).
        const total = segments.length
        for (let i = 0; i < total; i += 1) {
          const segment = segments[i]
          if (!segment) break
          ws.send(buildAudioRequest(seq, segment, i === total - 1))
          if (i !== total - 1) seq += 1
          // Simulate real-time streaming to avoid server-side rate limiting.
          await sleep(ASR_SEGMENT_MS)
        }
      } catch (error) {
        finish(error instanceof Error ? error : new VolcanoError(-1, String(error)))
      }
    })

    // 3) Receive responses until the terminal packet / error / close.
    ws.on('message', raw => {
      const parsed = parseResponse(toBuffer(raw))
      if (parsed.code !== 0) {
        finish(new VolcanoError(parsed.code, `volcano business error: ${parsed.error ?? ''}`))
        return
      }
      if (parsed.text) textParts.push(parsed.text)
      if (parsed.isLast) finish(null)
    })

    ws.on('error', error => finish(error instanceof Error ? error : new VolcanoError(-1, String(error))))

    ws.on('unexpected-response', (_req, res) => {
      finish(new VolcanoError(res.statusCode ?? -1, `websocket handshake rejected: HTTP ${res.statusCode ?? '?'}`))
    })

    ws.on('close', () => {
      // Server closed without an explicit terminal packet: resolve with
      // whatever text was accumulated (matches the Python loop exiting on
      // CLOSED and returning the joined text).
      finish(null)
    })
  })
}

/** Coerce a `ws` message payload (`RawData`) into a Buffer. */
function toBuffer(raw: unknown): Buffer {
  if (Buffer.isBuffer(raw)) return raw
  if (raw instanceof ArrayBuffer) return Buffer.from(raw)
  if (Array.isArray(raw)) return Buffer.concat(raw.filter((part): part is Buffer => Buffer.isBuffer(part)))
  if (raw instanceof Uint8Array) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
  return Buffer.alloc(0)
}
