import { describe, expect, it } from 'vitest'
import { gunzipSync, gzipSync } from 'node:zlib'
import {
  ASR_SAMPLE_RATE,
  CLIENT_AUDIO_ONLY,
  CLIENT_FULL,
  NEG_WITH_SEQ,
  POS_SEQ,
  SERVER_ERROR,
  SERVER_FULL,
  TTS_END_CODE,
  asrConfigPayload,
  asrSegmentSize,
  buildAudioRequest,
  buildFullRequest,
  buildHeader,
  buildTtsPayload,
  buildWavHeader,
  extractText,
  parseResponse,
  parseTtsLine,
  splitSegments,
} from './voiceVolcanoProtocol'

describe('Volcano ASR binary framing', () => {
  it('encodes the 4-byte protocol header with the documented nibble layout', () => {
    // version=1, headersize=1 -> 0x11; serial=1, compression=1 -> 0x11; reserved 0x00.
    expect(Array.from(buildHeader(CLIENT_FULL, POS_SEQ))).toEqual([0x11, 0x11, 0x11, 0x00])
    // CLIENT_AUDIO_ONLY(2) << 4 | POS_SEQ(1) = 0x21.
    expect(Array.from(buildHeader(CLIENT_AUDIO_ONLY, POS_SEQ))).toEqual([0x11, 0x21, 0x11, 0x00])
    // CLIENT_AUDIO_ONLY(2) << 4 | NEG_WITH_SEQ(3) = 0x23 (terminal packet).
    expect(Array.from(buildHeader(CLIENT_AUDIO_ONLY, NEG_WITH_SEQ))).toEqual([0x11, 0x23, 0x11, 0x00])
  })

  it('builds the full config request with deterministic prefix + recoverable config', () => {
    const frame = buildFullRequest(1)
    expect(frame.subarray(0, 4)).toEqual(Buffer.from([0x11, 0x11, 0x11, 0x00]))
    // big-endian signed int32 seq == 1.
    expect(frame.subarray(4, 8)).toEqual(Buffer.from([0, 0, 0, 1]))
    const declaredLen = frame.readUInt32BE(8)
    const body = frame.subarray(12)
    expect(declaredLen).toBe(body.length)
    // The gzip body must round-trip to the documented config object.
    expect(JSON.parse(gunzipSync(body).toString('utf-8'))).toEqual(asrConfigPayload())
    expect(frame.length).toBe(4 + 4 + 4 + body.length)
  })

  it('frames audio segments and negates the sequence number on the terminal packet', () => {
    const segment = Buffer.from([1, 2, 3, 4, 5, 6])

    const mid = buildAudioRequest(7, segment, false)
    expect(mid.subarray(0, 4)).toEqual(Buffer.from([0x11, 0x21, 0x11, 0x00]))
    expect(mid.subarray(4, 8)).toEqual(Buffer.from([0, 0, 0, 7])) // positive seq
    const midBody = mid.subarray(12)
    expect(mid.readUInt32BE(8)).toBe(midBody.length)
    expect(gunzipSync(midBody)).toEqual(segment)

    const last = buildAudioRequest(7, segment, true)
    expect(last.subarray(0, 4)).toEqual(Buffer.from([0x11, 0x23, 0x11, 0x00]))
    // -7 as big-endian signed int32 (two's complement).
    expect(last.subarray(4, 8)).toEqual(Buffer.from([0xff, 0xff, 0xff, 0xf9]))
    expect(gunzipSync(last.subarray(12))).toEqual(segment)
  })
})

describe('Volcano ASR response parsing', () => {
  /** Build a server frame the same way the server would, to validate round-trip. */
  function serverFrame(
    messageType: number,
    flags: number,
    payloadAfterHeader: Buffer,
  ): Buffer {
    return Buffer.concat([buildHeader(messageType, flags), payloadAfterHeader])
  }

  it('decodes a SERVER_FULL success frame (result.text) with the last flag set', () => {
    const json = Buffer.from(JSON.stringify({ result: { text: '你好 world' } }), 'utf-8')
    const body = gzipSync(json)
    // flags: POS_SEQ (0x01) carries a 4-byte seq; isLast bit (0x02). Then uint32 size + payload.
    const payload = Buffer.concat([
      Buffer.from([0, 0, 0, 1]), // seq
      (() => {
        const b = Buffer.alloc(4)
        b.writeUInt32BE(body.length, 0)
        return b
      })(),
      body,
    ])
    const parsed = parseResponse(serverFrame(SERVER_FULL, POS_SEQ | 0x02, payload))
    expect(parsed.code).toBe(0)
    expect(parsed.isLast).toBe(true)
    expect(parsed.text).toBe('你好 world')
  })

  it('decodes a SERVER_FULL frame carrying utterances', () => {
    const json = Buffer.from(JSON.stringify({ result: { utterances: [{ text: 'a' }, { text: 'b' }] } }), 'utf-8')
    const body = gzipSync(json)
    const size = Buffer.alloc(4)
    size.writeUInt32BE(body.length, 0)
    const parsed = parseResponse(serverFrame(SERVER_FULL, 0, Buffer.concat([size, body])))
    expect(parsed.text).toBe('ab')
  })

  it('decodes a SERVER_ERROR frame into its code', () => {
    const message = gzipSync(Buffer.from('bad request', 'utf-8'))
    const payload = Buffer.concat([
      (() => {
        const b = Buffer.alloc(4)
        b.writeInt32BE(30000001, 0)
        return b
      })(),
      (() => {
        const b = Buffer.alloc(4)
        b.writeUInt32BE(message.length, 0)
        return b
      })(),
      message,
    ])
    const parsed = parseResponse(serverFrame(SERVER_ERROR, 0, payload))
    expect(parsed.code).toBe(30000001)
  })

  it('flags unknown message types', () => {
    const parsed = parseResponse(serverFrame(0b0011, 0, Buffer.alloc(0)))
    expect(parsed.code).toBe(-1)
    expect(parsed.isLast).toBe(true)
    expect(parsed.error).toMatch(/unknown message_type/)
  })
})

describe('Volcano text extraction', () => {
  it('handles the documented response shapes', () => {
    expect(extractText({ result: { text: 'a' } })).toBe('a')
    expect(extractText({ result: { utterances: [{ text: 'x' }, { text: 'y' }] } })).toBe('xy')
    expect(extractText({ result: { utterance: [{ transcript: 'z' }] } })).toBe('z')
    expect(extractText({ text: 'b' })).toBe('b')
    expect(extractText({ result: 'c' })).toBe('c')
    expect(extractText('plain')).toBe('plain')
    expect(extractText(null)).toBe('')
    expect(extractText(undefined)).toBe('')
    expect(extractText({ unrelated: 1 })).toBe('')
  })
})

describe('Volcano ASR audio segmenting', () => {
  it('computes the 200ms byte budget for 16kHz/mono/16bit', () => {
    expect(asrSegmentSize(ASR_SAMPLE_RATE)).toBe(6400) // 16000 * 2 * 0.2
    expect(asrSegmentSize(8000)).toBe(3200)
  })

  it('slices buffers into fixed-size segments and degrades safely', () => {
    expect(splitSegments(Buffer.alloc(0), 6400)).toEqual([])
    expect(splitSegments(Buffer.alloc(10), 0).length).toBe(1)
    const segments = splitSegments(Buffer.alloc(6400 * 2 + 3), 6400)
    expect(segments.length).toBe(3)
    expect(segments[0]!.length).toBe(6400)
    expect(segments[2]!.length).toBe(3)
  })
})

describe('Volcano WAV header', () => {
  it('emits the canonical 44-byte little-endian header', () => {
    const header = buildWavHeader(100, 16000, 1, 16)
    expect(header.length).toBe(44)
    expect(header.toString('ascii', 0, 4)).toBe('RIFF')
    expect(header.readUInt32LE(4)).toBe(36 + 100)
    expect(header.toString('ascii', 8, 12)).toBe('WAVE')
    expect(header.toString('ascii', 12, 16)).toBe('fmt ')
    expect(header.readUInt16LE(20)).toBe(1) // PCM
    expect(header.readUInt16LE(22)).toBe(1) // mono
    expect(header.readUInt32LE(24)).toBe(16000)
    expect(header.readUInt16LE(34)).toBe(16) // bits
    expect(header.toString('ascii', 36, 40)).toBe('data')
    expect(header.readUInt32LE(40)).toBe(100)
  })
})

describe('Volcano TTS line parser', () => {
  it('decodes base64 audio chunks', () => {
    const original = Buffer.from([0, 1, 2, 3, 250, 251])
    const line = JSON.stringify({ code: 0, data: original.toString('base64') })
    const result = parseTtsLine(line)
    expect(result.kind).toBe('audio')
    if (result.kind === 'audio') expect(result.audio).toEqual(original)
  })

  it('recognizes the normal-termination sentinel', () => {
    expect(parseTtsLine(JSON.stringify({ code: TTS_END_CODE }))).toEqual({ kind: 'end' })
  })

  it('surfaces business error codes', () => {
    const result = parseTtsLine(JSON.stringify({ code: 30000001 }))
    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(result.code).toBe(30000001)
  })

  it('skips empty / non-JSON / dataless lines', () => {
    expect(parseTtsLine('')).toEqual({ kind: 'skip' })
    expect(parseTtsLine('not json')).toEqual({ kind: 'skip' })
    expect(parseTtsLine(JSON.stringify({ code: 0 }))).toEqual({ kind: 'skip' })
  })

  it('builds the documented request payload', () => {
    expect(buildTtsPayload('hi', 'speaker-x', 'mp3')).toEqual({
      req_params: {
        text: 'hi',
        speaker: 'speaker-x',
        audio_params: { format: 'mp3', sample_rate: 24000 },
      },
    })
  })
})

// Sanity: gzip round-trip behaves as the framing code assumes.
it('gzip round-trips raw bytes', () => {
  expect(gunzipSync(gzipSync(Buffer.from('abc')))).toEqual(Buffer.from('abc'))
})
