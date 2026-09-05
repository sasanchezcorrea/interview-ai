#!/usr/bin/env bun
// server/local-e2e.ts — the integration test that actually runs every time.
//
// It drives the REAL sidecar end to end with no browser: real WAVs over the real /audio socket,
// real segmenter, real whisper, real trigger heuristic, real streaming brain, real /events stream.
// Deterministic, ~2 minutes, no Chrome to fight.
//
// Two rules this file exists to enforce, both learned the hard way:
//  1. NEVER reimplement the code under test. The old in-panel autotest rebuilt the audio pipe
//     inline and therefore never ran pipePCM(), so twenty green tests covered code that had never
//     executed. Here the PCM conversion is LIFTED OUT OF panel.html AT RUNTIME and executed, so a
//     change to the panel's encoder breaks this test.
//  2. Assert the adversarial cases, not just the happy path. Silence, noise and a missing
//     screenshot each get a row, because "it answered something" is not the same as "it was right
//     to answer".
//
// Usage: bun server/local-e2e.ts [--json] [--keep]
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = dirname(import.meta.path);
const PORT = Number(process.env.IAI_PORT ?? 31338);
const SIDECAR = `http://127.0.0.1:${PORT}`;
const FIXTURES = "/tmp/interview-ai/local-e2e";
const FRAME_SAMPLES = 4096;
const SAMPLE_RATE = 16000;
const FRAME_MS = (FRAME_SAMPLES / SAMPLE_RATE) * 1000;
const LATENCY_BUDGET_MS = 3000;   // 2500 + the ~590 ms `medium` whisper buys us (see bench-stt)

const QUESTION_EN = "How would you design a multi-tenant RAG system where tenants must never see each other's data?";
const MIC_LINE = "I have three years of experience building multi tenant agent systems in production with Kubernetes and Python.";

interface Row { name: string; pass: boolean; detail: string }
interface EventRec { t: number; ev: Record<string, unknown> & { type?: string } }
const rows: Row[] = [];
const log = (...a: unknown[]) => console.error(new Date().toISOString().slice(11, 19), ...a);
const add = (name: string, pass: boolean, detail: string) => { rows.push({ name, pass, detail }); };

// ---------- the panel's own encoder, lifted out of panel.html ----------
/** Pulls the AudioWorklet source out of panel.html and runs it here. If the panel changes how it
 *  frames or scales PCM, this test fails — which is the whole point. */
function loadPanelEncoder(): (chunk: Float32Array, ch: number, emit: (b: ArrayBuffer) => void) => void {
  const html = readFileSync(join(ROOT, "panel.html"), "utf8");
  const m = html.match(/class Pcm extends AudioWorkletProcessor \{[\s\S]*?registerProcessor\("iai-pcm", Pcm\);/);
  if (!m) throw new Error("could not find the iai-pcm worklet in panel.html — did the encoder move?");
  let Processor: any = null;
  const scope = {
    AudioWorkletProcessor: class { port = { postMessage: (_: unknown) => {} } },
    registerProcessor: (_name: string, cls: any) => { Processor = cls; },
  };
  new Function("AudioWorkletProcessor", "registerProcessor", m[0])(scope.AudioWorkletProcessor, scope.registerProcessor);
  if (!Processor) throw new Error("the worklet source did not register a processor");
  const inst = new Processor();
  return (chunk, ch, emit) => {
    inst.port.postMessage = (buf: ArrayBuffer) => { new DataView(buf).setUint8(0, ch); emit(buf); };
    inst.process([[chunk]]);
  };
}

// ---------- fixtures ----------
async function say(text: string, voice: string, out: string): Promise<void> {
  if (existsSync(out)) return;
  const aiff = out.replace(/\.wav$/, ".aiff");
  const s = Bun.spawn(["say", "-v", voice, "-o", aiff, text], { stdout: "ignore", stderr: "pipe" });
  if ((await s.exited) !== 0) throw new Error(`say failed: ${await new Response(s.stderr).text()}`);
  const f = Bun.spawn(["ffmpeg", "-y", "-loglevel", "error", "-i", aiff, "-ar", String(SAMPLE_RATE), "-ac", "1", out], { stdout: "ignore", stderr: "pipe" });
  if ((await f.exited) !== 0) throw new Error(`ffmpeg failed: ${await new Response(f.stderr).text()}`);
  rmSync(aiff, { force: true });
}
async function lavfi(spec: string, out: string, seconds: number): Promise<void> {
  if (existsSync(out)) return;
  const f = Bun.spawn(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", spec, "-t", String(seconds), "-ac", "1", "-ar", String(SAMPLE_RATE), out], { stdout: "ignore", stderr: "pipe" });
  if ((await f.exited) !== 0) throw new Error(`ffmpeg failed: ${await new Response(f.stderr).text()}`);
}
async function exerciseJpeg(): Promise<Uint8Array> {
  const txt = join(FIXTURES, "task.txt"), jpg = join(FIXTURES, "task.jpg");
  await Bun.write(txt, [
    "CODING EXERCISE", "",
    "Write merge_intervals(intervals): given a list of closed",
    "intervals [start, end], return them with all overlapping",
    "intervals merged, sorted by start.", "",
    "Input:  [[1,3],[2,6],[8,10],[15,18]]",
    "Output: [[1,6],[8,10],[15,18]]", "",
    "Discuss time and space complexity. Python preferred.",
  ].join("\n"));
  const font = "/System/Library/Fonts/Supplemental/Courier New Bold.ttf";
  const f = Bun.spawn(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=white:s=1280x720",
    "-vf", `drawtext=fontfile=${font}:textfile=${txt}:fontcolor=black:fontsize=30:x=60:y=70:line_spacing=12`,
    "-frames:v", "1", jpg], { stdout: "ignore", stderr: "pipe" });
  if ((await f.exited) !== 0) throw new Error(`ffmpeg failed on the exercise: ${await new Response(f.stderr).text()}`);
  return new Uint8Array(await Bun.file(jpg).arrayBuffer());
}

// ---------- server plumbing ----------
const health = async () => (await fetch(`${SIDECAR}/health`)).json() as Promise<any>;
const post = (p: string, b: unknown) => fetch(`${SIDECAR}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });

class Events {
  all: EventRec[] = [];
  private ws!: WebSocket;
  async connect() {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/events`);
    await new Promise<void>((res, rej) => { this.ws.onopen = () => res(); this.ws.onerror = () => rej(new Error("no /events")); });
    this.ws.onmessage = (m) => this.all.push({ t: Date.now(), ev: JSON.parse(m.data as string) });
  }
  close() { try { this.ws.close(); } catch {} }
  since(t: number, type: string) { return this.all.filter((r) => r.t >= t && r.ev.type === type); }
  async wait(pred: (ev: any) => boolean, ms: number, since: number): Promise<EventRec | null> {
    const found = this.all.find((r) => r.t >= since && pred(r.ev));
    if (found) return found;
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = this.all.find((r) => r.t >= since && pred(r.ev));
      if (hit) return hit;
      await Bun.sleep(120);
    }
    return null;
  }
}

/** Streams a WAV through the panel's encoder into the real /audio socket, in real time. */
async function speak(wav: string, ch: 0 | 1, encode: ReturnType<typeof loadPanelEncoder>): Promise<number> {
  log(`  speak(${wav.split("/").pop()}, ch=${ch})`);
  const ff = Bun.spawn(["ffmpeg", "-v", "error", "-i", wav, "-f", "f32le", "-ar", String(SAMPLE_RATE), "-ac", "1", "-"], { stdout: "pipe" });
  const raw = new Float32Array(await new Response(ff.stdout).arrayBuffer());
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/audio`);
  await new Promise<void>((r) => (ws.onopen = () => r()));
  const CHUNK = 128;                                   // what an AudioWorklet render quantum is
  for (let off = 0; off < raw.length; off += CHUNK) {
    encode(raw.subarray(off, Math.min(off + CHUNK, raw.length)), ch, (b) => ws.send(b));
    if (off % (CHUNK * 8) === 0) await Bun.sleep(8);    // ~real time without a timer per quantum
  }
  const end = Date.now();
  const silence = new Float32Array(CHUNK);
  for (let i = 0; i < 90; i++) { encode(silence, ch, (b) => ws.send(b)); await Bun.sleep(8); }
  await Bun.sleep(500); ws.close();
  return end;
}

const words = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2);
function overlap(a: string, b: string) { const A = new Set(words(a)); const seen = new Set<string>(); for (const w of words(b)) if (A.has(w)) seen.add(w); return seen.size; }
const heard = (ev: Events, since: number, ch: string) => ev.since(since, "transcript").filter((r) => r.ev.ch === ch).map((r) => String(r.ev.text ?? "")).join(" ");

// ---------- the run ----------
async function main() {
  const jsonOut = process.argv.includes("--json");
  mkdirSync(FIXTURES, { recursive: true });

  // 1 — the sidecar is up and whisper is loaded
  let h: any;
  try { h = await health(); } catch { h = null; }
  if (!h?.ok) {
    const p = Bun.spawn(["bash", join(ROOT, "start.sh")], { stdout: "inherit", stderr: "inherit" });
    await p.exited; h = await health().catch(() => null);
  }
  add("sidecar_health", !!h?.ok && !!h?.whisper, h ? `ok=${h.ok} whisper=${h.whisper}` : "no response");
  if (!h?.ok) return finish(rows, jsonOut);

  // 2 — the panel's encoder, executed here, frames and scales as the wire format requires
  const encode = loadPanelEncoder();
  {
    const out: ArrayBuffer[] = [];
    const ramp = new Float32Array(FRAME_SAMPLES * 2);
    for (let i = 0; i < ramp.length; i++) ramp[i] = i % 2 ? 1 : -1;     // full scale, alternating
    for (let off = 0; off < ramp.length; off += 128) encode(ramp.subarray(off, off + 128), 1, (b) => out.push(b));
    const ok = out.length === 2 && out.every((b) => b.byteLength === 2 + FRAME_SAMPLES * 2);
    const dv = out[0] ? new DataView(out[0]) : null;
    const scaled = dv ? dv.getInt16(2, true) === -32768 && dv.getInt16(4, true) === 32767 : false;
    const chByte = dv ? dv.getUint8(0) === 1 : false;
    add("panel_encoder", ok && scaled && chByte,
      `frames=${out.length} bytes=${out[0]?.byteLength ?? 0} full-scale=${scaled} channel-byte=${chByte}`);
  }

  const ev = new Events(); await ev.connect();
  await post("/reset", {}); await Bun.sleep(800);

  log("building fixtures...");
  await say(QUESTION_EN, "Samantha", join(FIXTURES, "q_en.wav"));
  await say(MIC_LINE, "Daniel", join(FIXTURES, "mic.wav"));
  await lavfi("anullsrc=r=16000:cl=mono", join(FIXTURES, "silence.wav"), 5);
  await lavfi("anoisesrc=r=16000:c=pink:a=0.35", join(FIXTURES, "noise.wav"), 4);

  // 3-9 — a real question, all the way to a spoken answer
  log("asking the question...");
  const tQ = Date.now();
  log("streaming the question through the panel encoder...");
  const audioEnd = await speak(join(FIXTURES, "q_en.wav"), 0, encode);
  const framesAfter = (await health()).meters.them.frames;
  add("them_frames", framesAfter >= 20, `frames=${framesAfter} (a 6 s question is ~23 at ${FRAME_MS.toFixed(0)} ms each)`);
  const peak = (await health()).meters.them.peak;
  add("them_signal", peak > 0.005, `peak_rms=${peak.toFixed(4)}`);

  const tr = await ev.wait((e) => e.type === "transcript" && e.ch === "them", 20_000, tQ);
  await Bun.sleep(2000);
  const said = heard(ev, tQ, "them");
  add("transcript_them", overlap(QUESTION_EN, said) >= 4, `overlap=${overlap(QUESTION_EN, said)}/4 "${said.slice(0, 70)}"`);

  const firstDelta = await ev.wait((e) => e.type === "cue-delta", 12_000, tQ);
  add("auto_trigger", !!firstDelta, firstDelta ? "the question answered itself, no button" : "the trigger never fired on a question");
  add("first_token", !!firstDelta && firstDelta.t - audioEnd < 5000,
    firstDelta ? `first word ${firstDelta.t - audioEnd} ms after the question ended` : "no cue-delta");

  const done = await ev.wait((e) => e.type === "cue-done", 20_000, tQ);
  const deltas = ev.since(tQ, "cue-delta");
  const rebuilt = deltas.map((r) => String(r.ev.chunk ?? "")).join("");
  add("cue_streams", deltas.length >= 2 && !!done && rebuilt.trim() === String(done.ev.cue ?? "").trim(),
    `${deltas.length} deltas rebuild the cue exactly: ${rebuilt.trim() === String(done?.ev.cue ?? "").trim()}`);

  const ans = await ev.wait((e) => e.type === "answer" && String(e.cue ?? "").trim().length > 0, 30_000, tQ);
  add("answer_complete", !!ans && Array.isArray(ans.ev.points) && (ans.ev.points as unknown[]).length >= 1,
    ans ? `cue="${String(ans.ev.cue).slice(0, 55)}" points=${(ans.ev.points as unknown[]).length}` : "no answer");

  const lat = (await health()).latency;
  add("latency_budget", typeof lat.p95.qToFirstWordMs === "number" && lat.p95.qToFirstWordMs <= LATENCY_BUDGET_MS,
    `p95 question→first word = ${lat.p95.qToFirstWordMs}ms (budget ${LATENCY_BUDGET_MS}ms)`);

  // 10 — the candidate's own channel
  log("speaking on the candidate channel...");
  const tMe = Date.now();
  await speak(join(FIXTURES, "mic.wav"), 1, encode);
  await ev.wait((e) => e.type === "transcript" && e.ch === "me", 20_000, tMe);
  await Bun.sleep(2000);
  const mine = heard(ev, tMe, "me");
  add("me_channel", overlap(MIC_LINE, mine) >= 4, `overlap=${overlap(MIC_LINE, mine)}/4 "${mine.slice(0, 60)}"`);

  // 11-12 — adversarial: neither silence nor noise may invent a turn or spend a model call
  log("adversarial: silence and noise...");
  const tSil = Date.now();
  await speak(join(FIXTURES, "silence.wav"), 0, encode);
  await Bun.sleep(1500);
  add("silence_rejected", ev.since(tSil, "transcript").length === 0 && ev.since(tSil, "answer").length === 0,
    `${ev.since(tSil, "transcript").length} transcripts, ${ev.since(tSil, "answer").length} answers from 5 s of silence`);

  const tNoise = Date.now();
  await speak(join(FIXTURES, "noise.wav"), 0, encode);
  await Bun.sleep(1500);
  add("noise_rejected", ev.since(tNoise, "transcript").length === 0,
    `${ev.since(tNoise, "transcript").length} transcripts from 4 s of pink noise`);

  // 13 — solve refuses without a screen, then solves the one it is given
  await post("/reset", {}); await Bun.sleep(600);
  const r409 = await post("/answer-now", { mode: "solve" });
  add("solve_needs_screen", r409.status === 409, `POST /answer-now solve with no shot -> HTTP ${r409.status} (expected 409)`);

  log("solving what is on screen...");
  const jpg = await exerciseJpeg();
  const put = await fetch(`${SIDECAR}/shot`, { method: "POST", headers: { "content-type": "image/jpeg" }, body: new Blob([jpg.buffer as ArrayBuffer], { type: "image/jpeg" }) });
  const tSolve = Date.now();
  await post("/answer-now", { mode: "solve" });
  const solved = await ev.wait((e) => e.type === "answer" && e.mode === "solve", 60_000, tSolve);
  const body = String((solved?.ev.code as any)?.body ?? "");
  add("solve_code", put.ok && body.split("\n").length > 5,
    solved ? `lines=${body.split("\n").length} cue="${String(solved.ev.cue).slice(0, 50)}"` : "no solve answer in 60s");

  ev.close();
  finish(rows, jsonOut);
}

function finish(rows: Row[], jsonOut: boolean) {
  if (jsonOut) console.log(JSON.stringify({ rows, passed: rows.filter((r) => r.pass).length, total: rows.length }, null, 2));
  else {
    for (const r of rows) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(22)}${r.detail}`);
    const n = rows.filter((r) => r.pass).length;
    console.log(`\n${n}/${rows.length} passed`);
  }
  process.exit(rows.every((r) => r.pass) ? 0 : 1);
}

main().catch((e) => { add("harness", false, `fatal: ${(e as Error).message}`); finish(rows, process.argv.includes("--json")); });
