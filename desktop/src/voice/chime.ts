// Recording start/stop earcons, generated with the Web Audio API so no audio
// assets need to be bundled. Matches VoiceMode's two-tone feedback:
//   start = ascending 800 → 1000 Hz ("go")
//   end   = descending 1000 → 800 Hz ("stop")
// Each tone ~100 ms with a short fade to avoid clicks, at a modest volume.

export type ChimeKind = 'start' | 'end'

let playbackContext: AudioContext | null = null

function getPlaybackContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!playbackContext) {
    const Ctor = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    playbackContext = new Ctor()
  }
  return playbackContext
}

export function playVoiceChime(kind: ChimeKind): void {
  const audio = getPlaybackContext()
  if (!audio) return
  // Audio may start suspended until a user gesture; resume best-effort.
  void audio.resume().catch(() => undefined)

  const tones = kind === 'start' ? [800, 1000] : [1000, 800]
  const toneSeconds = 0.1
  const gapSeconds = 0.005
  const peak = 0.12
  const fade = 0.01
  const startAt = audio.currentTime + 0.02

  const master = audio.createGain()
  master.gain.value = 0.0001
  master.connect(audio.destination)

  tones.forEach((frequency, index) => {
    const osc = audio.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = frequency

    const t0 = startAt + index * (toneSeconds + gapSeconds)
    const t1 = t0 + toneSeconds
    // Envelope: fade in to peak, hold, fade out — per tone, on the shared gain.
    master.gain.setValueAtTime(0.0001, t0)
    master.gain.exponentialRampToValueAtTime(peak, t0 + fade)
    master.gain.exponentialRampToValueAtTime(0.0001, t1 - fade)
    master.gain.setValueAtTime(0.0001, t1)

    osc.connect(master)
    osc.start(t0)
    osc.stop(t1 + 0.005)
  })
}
