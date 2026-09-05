import { describe, expect, test } from "bun:test";
import { Segmenter, wavFromPcm16, looksLikeQuestion, isHallucination, SAMPLE_RATE } from "./audio";

const FRAME = 1600; // 100 ms at 16 kHz
const silence = () => new Int16Array(FRAME);
const noise = (amp = 6000) => { const f = new Int16Array(FRAME); for (let i = 0; i < FRAME; i++) f[i] = Math.round((Math.random() * 2 - 1) * amp); return f; };
const feed = (seg: Segmenter, frames: Int16Array[]) => { for (const f of frames) seg.push(f); };

describe("Segmenter", () => {
  test("silence → speech → silence emits one segment with preroll and trailing pause", () => {
    const out: number[] = [];
    const SILENCE = 450, PREROLL = 300;
    const seg = new Segmenter((s) => out.push(s.durationMs), { silenceMs: SILENCE, prerollMs: PREROLL });
    feed(seg, [...Array(10)].map(silence));          // 1 s quiet
    feed(seg, [...Array(20)].map(() => noise()));    // 2 s speech
    feed(seg, [...Array(10)].map(silence));          // 1 s quiet → closes after SILENCE
    expect(out.length).toBe(1);
    expect(out[0]).toBeGreaterThanOrEqual(2000 + PREROLL + SILENCE - 1);
    expect(out[0]).toBeLessThan(2000 + PREROLL + SILENCE + 200);
  });

  test("the default silence window stays inside the latency budget", () => {
    // Every ms here lands directly on "interviewer stops talking → candidate hears the cue".
    // 800 ms was a third of the budget; if someone raises it back, this fails on purpose.
    let closedAfter = 0;
    const seg = new Segmenter((s) => (closedAfter = s.durationMs));
    feed(seg, [...Array(10)].map(() => noise()));    // 1 s speech, no explicit options
    feed(seg, [...Array(10)].map(silence));
    expect(closedAfter).toBeLessThanOrEqual(1000 + 300 + 500);
  });
  test("long speech is cut at maxMs", () => {
    const out: number[] = [];
    const seg = new Segmenter((s) => out.push(s.durationMs), { maxMs: 3000 });
    feed(seg, [...Array(70)].map(() => noise()));    // 7 s continuous
    expect(out.length).toBe(2);
    expect(out[0]).toBeLessThanOrEqual(3000 + 100);
  });
  test("a blip shorter than minSpeechMs is dropped", () => {
    const out: number[] = [];
    const seg = new Segmenter((s) => out.push(s.durationMs));
    feed(seg, [...Array(5)].map(silence));
    feed(seg, [noise(), noise()]);                   // 200 ms
    feed(seg, [...Array(10)].map(silence));
    expect(out.length).toBe(0);
  });
  test("flush() closes an open segment (answer now)", () => {
    const out: number[] = [];
    const seg = new Segmenter((s) => out.push(s.durationMs));
    feed(seg, [...Array(8)].map(() => noise()));
    expect(out.length).toBe(0);
    seg.flush();
    expect(out.length).toBe(1);
  });
});

test("wavFromPcm16 writes a valid 16 kHz mono header", () => {
  const pcm = new Int16Array([1, -1, 32767, -32768]);
  const wav = wavFromPcm16(pcm);
  const dv = new DataView(wav.buffer);
  const tag = (o: number) => String.fromCharCode(...wav.subarray(o, o + 4));
  expect(tag(0)).toBe("RIFF"); expect(tag(8)).toBe("WAVE"); expect(tag(12)).toBe("fmt "); expect(tag(36)).toBe("data");
  expect(dv.getUint32(24, true)).toBe(SAMPLE_RATE);
  expect(dv.getUint16(22, true)).toBe(1);
  expect(dv.getUint16(34, true)).toBe(16);
  expect(dv.getUint32(40, true)).toBe(8);
  expect(wav.length).toBe(44 + 8);
  expect(new Int16Array(wav.buffer, 44)[2]).toBe(32767);
});

test("looksLikeQuestion: es/en questions yes, statements no", () => {
  for (const q of ["¿Puedes contarme sobre tu experiencia con Kubernetes?", "Cuéntame de un proyecto difícil", "Tell me about a time you led a migration", "How would you design a rate limiter", "what's your experience with MCP", "Let's move to the coding exercise"]) expect(looksLikeQuestion(q)).toBe(true);
  for (const s of ["Perfecto, gracias.", "So that's the team structure.", "We use Python and Go here.", ""]) expect(looksLikeQuestion(s)).toBe(false);
});

test("isHallucination drops whisper boilerplate", () => {
  for (const h of ["[BLANK_AUDIO]", "(música)", "Subtítulos realizados por la comunidad de Amara.org", "Thanks for watching!", "...", ""]) expect(isHallucination(h)).toBe(true);
  expect(isHallucination("Tell me about yourself")).toBe(false);
});
