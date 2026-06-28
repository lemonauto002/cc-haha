// Volcano (ByteDance / 火山方舟 Agent Plan) speech protocol primitives.
//
// This module is intentionally pure: it depends only on `node:zlib` and
// `Buffer`. It contains NO networking (`ws` / `fetch`) so the binary framing
// can be unit-tested deterministically and ported byte-for-byte from the
// VoiceMode Python reference proxies:
//   ~/.voicemode/services/volc-tts/voicemode_volc_proxy.py
//   ~/.voicemode/services/volc-asr/voicemode_volc_asr_proxy.py
//
// The ASR binary framing (gzip + sequence numbers + negative-seq last packet)
// is transplanted verbatim from the official Volcano example (see `_Proto` and
// `_full_request` / `_audio_request` / `_parse_response` in the ASR proxy).

import { gzipSync, gunzipSync } from 'node:zlib'

// ---------------------------------------------------------------------------
// Shared error type
// ---------------------------------------------------------------------------

export class VolcanoError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(`volcano code=${code}: ${message}`)
    this.name = 'VolcanoError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// Audio helpers
// ---------------------------------------------------------------------------

/** Build a 44-byte little-endian WAV header for raw PCM. Mirrors Python `_wav_header`. */
export function buildWavHeader(
  pcmLen: number,
  sampleRate: number,
  channels = 1,
  bits = 16,
): Buffer {
  const byteRate = sampleRate * channels * (bits / 8)
  const blockAlign = channels * (bits / 8)
  const buf = Buffer.alloc(44)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + pcmLen, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(channels, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(byteRate, 28)
  buf.writeUInt16LE(blockAlign, 32)
  buf.writeUInt16LE(bits, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(pcmLen, 40)
  return buf
}

/** Copy a Node Buffer's bytes into a standalone ArrayBuffer (IPC structured-clone friendly). */
export function bufferToArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

// ---------------------------------------------------------------------------
// ASR binary framing protocol
// ---------------------------------------------------------------------------

export const ASR_ENDPOINT =
  'wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_nostream'
export const ASR_DEFAULT_RESOURCE_ID = 'volc.seedasr.sauc.duration'
export const ASR_SAMPLE_RATE = 16000
export const ASR_SEGMENT_MS = 200

// Protocol version + message types + flags (verbatim from `_Proto`).
const VERSION = 0b0001
export const CLIENT_FULL = 0b0001
export const CLIENT_AUDIO_ONLY = 0b0010
export const SERVER_FULL = 0b1001
export const SERVER_ERROR = 0b1111
export const NEG_WITH_SEQ = 0b0011 // last packet: negative sequence
export const POS_SEQ = 0b0001 // positive sequence
const SER_JSON = 0b0001
const COMP_GZIP = 0b0001

function int32BE(value: number): Buffer {
  const buf = Buffer.alloc(4)
  buf.writeInt32BE(value, 0)
  return buf
}

function uint32BE(value: number): Buffer {
  const buf = Buffer.alloc(4)
  buf.writeUInt32BE(value, 0)
  return buf
}

/** 4-byte protocol header: version+headersize | msgtype+flags | serial+compression | reserved. */
export function buildHeader(messageType: number, flags: number): Buffer {
  return Buffer.from([
    (VERSION << 4) | 1,
    (messageType << 4) | flags,
    (SER_JSON << 4) | COMP_GZIP,
    0x00,
  ])
}

/** Default ASR config payload (identical to Python `_full_request`). */
export function asrConfigPayload(): Record<string, unknown> {
  return {
    user: { uid: 'voicemode' },
    audio: { format: 'wav', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
    request: {
      model_name: 'bigmodel',
      enable_itn: true,
      enable_punc: true,
      enable_ddc: true,
      show_utterances: true,
      enable_nonstream: false,
    },
  }
}

/** Frame the initial CLIENT_FULL config request. Mirrors `_full_request`. */
export function buildFullRequest(seq: number): Buffer {
  const body = gzipSync(Buffer.from(JSON.stringify(asrConfigPayload()), 'utf-8'))
  return Buffer.concat([buildHeader(CLIENT_FULL, POS_SEQ), int32BE(seq), uint32BE(body.length), body])
}

/**
 * Frame an audio segment. When `isLast`, flags=NEG_WITH_SEQ and the sequence
 * number is negated (terminal packet). Mirrors `_audio_request`.
 */
export function buildAudioRequest(seq: number, segment: Buffer, isLast: boolean): Buffer {
  const flags = isLast ? NEG_WITH_SEQ : POS_SEQ
  const actualSeq = isLast ? -seq : seq
  const body = gzipSync(segment)
  return Buffer.concat([
    buildHeader(CLIENT_AUDIO_ONLY, flags),
    int32BE(actualSeq),
    uint32BE(body.length),
    body,
  ])
}

export type ParsedResponse = {
  code: number
  isLast: boolean
  text: string
  raw: unknown
  error?: string
}

/** Parse a server binary frame. Mirrors `_parse_response`. */
export function parseResponse(msg: Buffer): ParsedResponse {
  if (msg.length < 4) {
    return { code: -1, isLast: true, text: '', raw: null, error: 'frame too short' }
  }
  const headerByte = msg[0] ?? 0
  const typeByte = msg[1] ?? 0
  const compressionByte = msg[2] ?? 0
  const headerSize = headerByte & 0x0f
  const messageType = typeByte >> 4
  const flags = typeByte & 0x0f
  const compression = compressionByte & 0x0f
  let payload = msg.subarray(headerSize * 4)

  const isLast = (flags & 0x02) !== 0
  let code = 0

  if (messageType === SERVER_ERROR) {
    code = payload.readInt32BE(0)
    const size = payload.readUInt32BE(4)
    payload = payload.subarray(8, 8 + size)
  } else if (messageType === SERVER_FULL) {
    if ((flags & 0x01) !== 0) payload = payload.subarray(4) // sequence number
    if ((flags & 0x04) !== 0) payload = payload.subarray(4) // event
    const size = payload.readUInt32BE(0)
    payload = payload.subarray(4, 4 + size)
  } else {
    return { code: -1, isLast: true, text: '', raw: null, error: `unknown message_type=${messageType}` }
  }

  if (compression === COMP_GZIP) {
    try {
      payload = gunzipSync(payload)
    } catch (error) {
      return {
        code: -1,
        isLast: true,
        text: '',
        raw: null,
        error: `decompress failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  let raw: unknown = null
  if (payload.length > 0) {
    try {
      raw = JSON.parse(payload.toString('utf-8'))
    } catch {
      // Ignore non-JSON payloads (some control frames carry no body).
    }
  }

  return { code, isLast, text: extractText(raw), raw }
}

/** Defensive text extraction across plausible response schemas. Mirrors `_extract_text` / `_utter_text`. */
export function extractText(node: unknown): string {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (typeof node !== 'object') return ''

  const obj = node as Record<string, unknown>
  const result = obj.result
  if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
    const r = result as Record<string, unknown>
    if (typeof r.text === 'string' && r.text) return r.text
    const utts = r.utterances ?? r.utterance
    if (Array.isArray(utts)) return utts.map(utteranceText).join('')
  }
  if (typeof obj.text === 'string' && obj.text) return obj.text
  const utts = obj.utterances ?? obj.utterance
  if (Array.isArray(utts)) return utts.map(utteranceText).join('')
  if (typeof result === 'string') return result
  return ''
}

function utteranceText(u: unknown): string {
  if (typeof u === 'string') return u
  if (u !== null && typeof u === 'object') {
    const o = u as Record<string, unknown>
    return typeof o.text === 'string' && o.text
      ? o.text
      : typeof o.transcript === 'string'
        ? o.transcript
        : ''
  }
  return ''
}

/**
 * Bytes consumed per audio segment for the given sample rate / mono / 16-bit.
 * At 16kHz that is 16000 * 2 * 0.2 = 6400 bytes per 200ms segment.
 */
export function asrSegmentSize(sampleRate: number, segmentMs = ASR_SEGMENT_MS): number {
  const bytesPerSec = sampleRate * 2 // mono 16-bit
  return Math.max(1, Math.floor((bytesPerSec * segmentMs) / 1000))
}

/** Slice a buffer into fixed-size segments. Mirrors `split_segments`. */
export function splitSegments(data: Buffer, size: number): Buffer[] {
  if (size <= 0) return data.length > 0 ? [data] : []
  const segments: Buffer[] = []
  for (let i = 0; i < data.length; i += size) {
    segments.push(data.subarray(i, i + size))
  }
  return segments.length > 0 ? segments : data.length > 0 ? [data] : []
}

// ---------------------------------------------------------------------------
// TTS line-stream parser
// ---------------------------------------------------------------------------

export const TTS_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional'
export const TTS_DEFAULT_RESOURCE_ID = 'seed-tts-2.0'
export const TTS_DEFAULT_SPEAKER = 'zh_female_vv_uranus_bigtts'
export const TTS_SAMPLE_RATE = 24000
/** Volcano's normal-termination sentinel (no audio). */
export const TTS_END_CODE = 20000000

export type TtsParseResult =
  | { kind: 'audio'; audio: Buffer }
  | { kind: 'end' }
  | { kind: 'error'; code: number }
  | { kind: 'skip' }

/**
 * Parse one streamed JSON line. Mirrors Python `_parse_line`:
 *   - code == 20000000  → terminal "end"
 *   - code != 0          → business error
 *   - otherwise          → base64-decoded audio chunk (or skip when empty)
 */
export function parseTtsLine(line: string): TtsParseResult {
  if (!line) return { kind: 'skip' }
  let parsed: { code?: unknown; data?: unknown }
  try {
    parsed = JSON.parse(line)
  } catch {
    return { kind: 'skip' }
  }
  const code = typeof parsed.code === 'number' ? parsed.code : 0
  if (code === TTS_END_CODE) return { kind: 'end' }
  if (code !== 0) return { kind: 'error', code }
  if (typeof parsed.data === 'string' && parsed.data) {
    return { kind: 'audio', audio: Buffer.from(parsed.data, 'base64') }
  }
  return { kind: 'skip' }
}

/** Build the TTS request body. Mirrors Python `_build_payload`. */
export function buildTtsPayload(
  text: string,
  speaker: string,
  format: 'mp3' | 'pcm' | 'wav',
): Record<string, unknown> {
  return {
    req_params: {
      text,
      speaker,
      audio_params: { format, sample_rate: TTS_SAMPLE_RATE },
    },
  }
}

export function ttsMediaType(format: 'mp3' | 'pcm' | 'wav'): string {
  return format === 'mp3' ? 'audio/mpeg' : format === 'wav' ? 'audio/wav' : 'audio/pcm'
}
