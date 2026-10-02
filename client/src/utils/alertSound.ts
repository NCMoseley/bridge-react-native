let ctx: AudioContext | null = null

const ENABLED_KEY = 'bridge:alertSound'

export function isAlertSoundEnabled() {
  try {
    return localStorage.getItem(ENABLED_KEY) !== 'off'
  } catch {
    return true
  }
}

export function setAlertSoundEnabled(enabled: boolean) {
  try {
    localStorage.setItem(ENABLED_KEY, enabled ? 'on' : 'off')
  } catch {
    // storage unavailable — ignore
  }
  window.dispatchEvent(new Event('bridge:alert-sound'))
}

function audioContext() {
  const Ctor =
    window.AudioContext ??
    (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  ctx ??= new Ctor()
  return ctx
}

interface Tone {
  freq: number
  at?: number
  dur?: number
  type?: OscillatorType
  gain?: number
}

const queue: Tone[][] = []
let draining = false

function schedule(tones: Tone[]) {
  const audio = ctx!
  const start = audio.currentTime + 0.02
  let end = 0
  for (const tone of tones) {
    const at = start + (tone.at ?? 0)
    const dur = tone.dur ?? 0.25
    const osc = audio.createOscillator()
    const gain = audio.createGain()
    osc.type = tone.type ?? 'sine'
    osc.frequency.setValueAtTime(tone.freq, at)
    gain.gain.setValueAtTime(tone.gain ?? 0.2, at)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur)
    osc.connect(gain)
    gain.connect(audio.destination)
    osc.start(at)
    osc.stop(at + dur)
    end = Math.max(end, (tone.at ?? 0) + dur)
  }
  return end
}

async function drain() {
  if (draining) return
  draining = true
  try {
    const audio = audioContext()
    if (!audio) {
      queue.length = 0
      return
    }
    if (audio.state === 'suspended') await audio.resume()
    while (queue.length) {
      if (audio.state !== 'running') {
        queue.length = 0
        break
      }
      const tones = queue.shift()!
      const end = schedule(tones)
      await new Promise((r) => setTimeout(r, end * 1000 + 60))
    }
  } catch {
    queue.length = 0
  } finally {
    draining = false
  }
}

function playTones(tones: Tone[]) {
  if (queue.length > 8) queue.shift()
  queue.push(tones)
  void drain()
}

export function playAlertBeep(force = false) {
  if (!force && !isAlertSoundEnabled()) return
  playTones([
    { freq: 880 },
    { freq: 1174.66, at: 0.12 },
  ])
}

export function playToastSound(type: 'success' | 'error' | 'warning', force = false) {
  if (!force && !isAlertSoundEnabled()) return
  if (type === 'error') {
    playTones([{ freq: 220, type: 'sawtooth', dur: 0.5, gain: 0.2 }])
  } else if (type === 'warning') {
    playTones([
      { freq: 659.25, dur: 0.1 },
      { freq: 659.25, at: 0.14, dur: 0.1 },
    ])
  } else {
    playTones([
      { freq: 523.25, dur: 0.12 },
      { freq: 783.99, at: 0.11, dur: 0.2 },
    ])
  }
}

export function unlockAlertAudio() {
  try {
    const audio = audioContext()
    if (audio?.state === 'suspended') void audio.resume()
  } catch {
    // audio unavailable — ignore
  }
}
