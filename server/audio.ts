// audio.ts — pure functions for the Interview AI sidecar: silence segmenter, WAV encoder,
// question detector, whisper hallucination filter. No I/O, so segmenter.test.ts can import it.

export const SAMPLE_RATE = 16000;

export interface Segment { pcm: Int16Array; durationMs: number }

export interface SegmenterOptions {
  silenceMs: number;      // trailing silence that closes a segment
  maxMs: number;          // hard cap per segment
  minSpeechMs: number;    // drop segments shorter than this
  prerollMs: number;      // audio kept from before speech onset
  startThreshold: number; // RMS floor (0..1) below which nothing is ever "voiced"
}

const DEFAULTS: SegmenterOptions = { silenceMs: 800, maxMs: 8000, minSpeechMs: 400, prerollMs: 300, startThreshold: 0.012 };

export function rmsOf(f: Int16Array): number {
  let s = 0;
  for (let i = 0; i < f.length; i++) { const v = f[i] / 32768; s += v * v; }
  return Math.sqrt(s / (f.length || 1));
}

/** Energy-based voice segmenter with an adaptive noise floor. Feed PCM16 frames, get segments. */
export class Segmenter {
  private opt: SegmenterOptions;
  private chunks: Int16Array[] = [];
  private preroll: Int16Array[] = [];
  private prerollMs = 0;
  private speechMs = 0;
  private silenceMs = 0;
  private voicedMs = 0; // frames above threshold only (preroll and pauses excluded)
  private inSpeech = false;
  private noise = 0.003; // EMA of quiet-frame RMS

  constructor(private onSegment: (s: Segment) => void, opt: Partial<SegmenterOptions> = {}) {
    this.opt = { ...DEFAULTS, ...opt };
  }

  push(frame: Int16Array): void {
    const ms = (frame.length / SAMPLE_RATE) * 1000;
    const rms = rmsOf(frame);
    const threshold = Math.max(this.opt.startThreshold, this.noise * 3.5);
    const voiced = rms > threshold;
    if (!voiced) this.noise = this.noise * 0.95 + rms * 0.05;

    if (this.inSpeech) {
      this.chunks.push(frame);
      this.speechMs += ms;
      if (voiced) { this.silenceMs = 0; this.voicedMs += ms; } else this.silenceMs += ms;
      if (this.silenceMs >= this.opt.silenceMs || this.speechMs >= this.opt.maxMs) this.flush();
      return;
    }
    if (voiced) {
      this.inSpeech = true;
      this.chunks = [...this.preroll, frame];
      this.speechMs = this.prerollMs + ms;
      this.voicedMs = ms;
      this.silenceMs = 0;
      this.preroll = []; this.prerollMs = 0;
      return;
    }
    this.preroll.push(frame); this.prerollMs += ms;
    while (this.prerollMs > this.opt.prerollMs && this.preroll.length) {
      this.prerollMs -= (this.preroll[0].length / SAMPLE_RATE) * 1000;
      this.preroll.shift();
    }
  }

  /** Close the open segment now (end of stream, or user pressed "answer now"). */
  flush(): void {
    if (!this.inSpeech) return;
    const voicedMs = this.voicedMs;
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const pcm = new Int16Array(total);
    let off = 0;
    for (const c of this.chunks) { pcm.set(c, off); off += c.length; }
    this.chunks = []; this.speechMs = 0; this.silenceMs = 0; this.voicedMs = 0; this.inSpeech = false;
    if (voicedMs >= this.opt.minSpeechMs) this.onSegment({ pcm, durationMs: (total / SAMPLE_RATE) * 1000 });
  }
}

/** 16-bit mono PCM → WAV bytes (44-byte RIFF header). */
export function wavFromPcm16(pcm: Int16Array, sampleRate = SAMPLE_RATE): Uint8Array<ArrayBuffer> {
  const dataBytes = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); dv.setUint32(4, 36 + dataBytes, true); str(8, "WAVE");
  str(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  str(36, "data"); dv.setUint32(40, dataBytes, true);
  new Int16Array(buf, 44).set(pcm);
  return new Uint8Array(buf);
}

const Q_START = /^(¿\s*)?(qué|que|cómo|como|cuál|cual|cuáles|cuales|cuándo|cuando|dónde|donde|quién|quien|por qué|porqué|cuéntame|cuentame|cuéntanos|explica|explícame|explicame|describe|háblame|hablame|dime|dinos|puedes|podrías|podrias|sabes|tienes|has |what|how|why|when|where|which|who|tell me|tell us|explain|describe|walk me|walk us|can you|could you|would you|do you|did you|have you|are you|is there|what's|whats|let's|lets|write|implement|design|solve|give me|give us|share)\b/i;
const Q_INSIDE = /\b(cuéntame|háblame|explícame|tell me about|walk me through|how would you|what would you|talk about|your experience with|háblanos de|cuéntanos de)\b/i;

/** Heuristic: does this interviewer turn ask for a reply? */
export function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/[?¿]/.test(t)) return true;
  return Q_START.test(t) || Q_INSIDE.test(t);
}

/** Whisper emits boilerplate on silence/noise; drop it before it pollutes the transcript. */
export function isHallucination(text: string): boolean {
  const t = text.trim();
  if (t.replace(/[^\p{L}\p{N}]/gu, "").length < 2) return true;
  if (/^[\[(*].*[\])*]$/.test(t)) return true; // [BLANK_AUDIO], (música), *aplausos*
  if (/subt[ií]tulos|amara\.org|gracias por ver|thanks for watching|suscr[ií]b|subscribe|www\./i.test(t)) return true;
  return false;
}
