#!/usr/bin/env bun
// server.ts — Interview AI sidecar. One Bun process on :31338:
//   GET  /            panel.html (the candidate's own window; capture, transcript, cue, code)
//   WS   /audio       PCM16 @16k frames from the panel: [ch, 0, int16le...]  ch 0=them (call tab) 1=me (mic)
//   WS   /events      server → panel: transcript turns, thinking, answers, status
//   POST /shot        JPEG of the shared screen (only when it changed)
//   POST /answer-now  {mode: answer|solve, effort: quick|deep}
//   POST /context     {jd} → USER/INTERVIEW_AI/jd.md + new brain session
//   POST /settings    {auto?, effort?}     POST /reset      POST /tts {text}
//   GET  /mock        fake interviewer page for E2E (speaks via `say`, shows a coding task)
// Audio → Segmenter (audio.ts) → whisper-server (:8178, started here if needed) → transcript → Brain (brain.ts).
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { ServerWebSocket, Subprocess } from "bun";
import { Segmenter, wavFromPcm16, looksLikeQuestion, isHallucination, rmsOf, domainPrompt, trigramSimilarity, type Segment } from "./audio";
import { Brain, type Effort, type Mode, type Turn } from "./brain";
import { handleVoiceRequest } from "./voice";
import { startNative, stopNative, nativeStatus, listSources, type AppStatus } from "./native";

const ROOT = dirname(import.meta.path);
const PORT = Number(process.env.IAI_PORT ?? 31338);
const WHISPER_PORT = Number(process.env.IAI_WHISPER_PORT ?? 8178);
const WHISPER_MODEL = process.env.IAI_WHISPER_MODEL ?? join(homedir(), ".cache/whisper/ggml-medium.bin");
const WHISPER_PROMPT_OVERRIDE = process.env.IAI_WHISPER_PROMPT;
const VAD_MODEL = process.env.IAI_VAD_MODEL ?? join(homedir(), ".cache/whisper/ggml-silero-v5.1.2.bin");
const VAD_URL = "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin";
const PULSE_NOTIFY = process.env.IAI_PULSE_URL ?? "http://localhost:31337/notify";
const SHOT_DIR = "/tmp/interview-ai";
// Where the candidate's dossier and job context live. Portable by default so the plugin works
// on a plain Claude Code install; IAI_USER_DIR overrides it, and an existing LifeOS folder is
// adopted so upgrading from the pre-marketplace layout does not silently lose the dossier.
const LEGACY_USER_DIR = join(homedir(), ".claude/LIFEOS/USER/INTERVIEW_AI");
const USER_DIR = process.env.IAI_USER_DIR
  ?? (existsSync(LEGACY_USER_DIR) ? LEGACY_USER_DIR : join(homedir(), ".interview-ai"));
mkdirSync(USER_DIR, { recursive: true });
mkdirSync(SHOT_DIR, { recursive: true });
mkdirSync(USER_DIR, { recursive: true });

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- state ----------
type Ch = "them" | "me";
type WsData = { kind: "audio" | "events" };
const transcript: Turn[] = [];
let sentUpTo = 0; // transcript turns already given to the brain
let latestShot: { path: string; t: number } | null = null;
let shotDirty = false;
const settings = { auto: true, effort: "quick" as Effort };
const clients = new Set<ServerWebSocket<WsData>>();
/** Live audio meters per channel — the panel's channel strips read these, and they are the
 *  answer to "is it hearing me?". Without them a dead capture is indistinguishable from silence. */
type Meter = { frames: number; bytes: number; rms: number; peak: number; lastAt: number; firstAt: number; dropped: number };
const meters: Record<Ch, Meter> = {
  them: { frames: 0, bytes: 0, rms: 0, peak: 0, lastAt: 0, firstAt: 0, dropped: 0 },
  me: { frames: 0, bytes: 0, rms: 0, peak: 0, lastAt: 0, firstAt: 0, dropped: 0 },
};
const discarded: Record<Ch, number> = { them: 0, me: 0 };
/** Below this a segment is room tone, not speech — and whisper will happily write sentences from
 *  room tone. Measured here: real speech peaks around 0.085, an empty room 0.001-0.004. */
const MIN_SEGMENT_PEAK = Number(process.env.IAI_MIN_PEAK ?? 0.02);
/** Word overlap of a clean repeat runs high; a garbled one shows up in the trigram score, which
 *  is lower by nature. One threshold for both, set where the garbled case still trips it. */
const ECHO_THRESHOLD = Number(process.env.IAI_ECHO_THRESHOLD ?? 0.45);
/** What has recently gone out of the speakers or come in on the other channel. With speakers on,
 *  ScreenCaptureKit taps the system output, so the copilot's OWN spoken cue arrives back on the
 *  interviewer channel — and the copilot would then answer itself. This is the guard. */
const spoken: { text: string; t: number; src: "cue" | Ch }[] = [];
const rememberSpoken = (text: string, src: "cue" | Ch) => { if (text.trim()) spoken.push({ text, t: Date.now(), src }); while (spoken.length > 16) spoken.shift(); };
const norm = (t: string) => t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3);
/** Fraction of the heard words that also appear in something we just played or received. */
function echoOverlap(heard: string, ch: Ch): { frac: number; src: string } {
  const hw = norm(heard);
  if (hw.length < 3) return { frac: 0, src: "" };
  let best = { frac: 0, src: "" };
  for (const s of spoken) {
    if (Date.now() - s.t > 25_000) continue;
    // Asymmetric on purpose, because the physics are asymmetric. System audio is the clean source
    // of the interviewer's voice; the microphone is where it bleeds in second-hand. So the
    // interviewer channel is only ever checked against cues WE spoke, never against the mic —
    // checking both ways killed the real question whenever its echo happened to land first.
    if (ch === "them" && s.src !== "cue") continue;
    if (ch === "me" && s.src === "me") continue;
    const words = new Set(norm(s.text));
    if (!words.size) continue;
    const wordFrac = hw.filter((w) => words.has(w)).length / hw.length;
    // Take whichever notices it: word overlap catches a clean repeat, trigrams catch the garbled
    // version whisper produces from audio it half-heard.
    const frac = Math.max(wordFrac, trigramSimilarity(heard, s.text));
    if (frac > best.frac) best = { frac, src: s.src === "cue" ? "our own voice" : "the other channel" };
  }
  return best;
}
/** Latency budget. qToVoiceMs is the only number that matches what the candidate feels: silence
 *  between the interviewer stopping and the first spoken word being on screen. The other three
 *  say which stage to blame for it. */
type LatencyKey = "sttMs" | "firstTokenMs" | "totalMs" | "qToFirstWordMs" | "qToVoiceMs";
const LATENCY_KEYS: LatencyKey[] = ["sttMs", "firstTokenMs", "totalMs", "qToFirstWordMs", "qToVoiceMs"];
const samples: Record<LatencyKey, number[]> = { sttMs: [], firstTokenMs: [], totalMs: [], qToFirstWordMs: [], qToVoiceMs: [] };
function sample(k: LatencyKey, ms: number) { const a = samples[k]; a.push(Math.round(ms)); if (a.length > 50) a.shift(); }
const pct = (a: number[], p: number): number | null =>
  a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.ceil(p * a.length) - 1)]! : null;
const pcts = (p: number) => Object.fromEntries(LATENCY_KEYS.map((k) => [k, pct(samples[k], p)])) as Record<LatencyKey, number | null>;
const latency = () => ({ n: samples.qToFirstWordMs.length, p50: pcts(0.5), p95: pcts(0.95) });
/** When the segmenter closed the turn's audio — the clock qToVoiceMs starts on. Weak so finished
 *  turns are collectable; a manual "answer now" with no new question simply finds nothing. */
const segEndAt = new WeakMap<Turn, number>();
const brain = new Brain({ dossierPath: join(USER_DIR, "dossier.md"), jdPath: join(USER_DIR, "jd.md") });
const segmenters: Record<Ch, Segmenter> = {
  them: new Segmenter((s) => onSegment("them", s, Date.now())),
  me: new Segmenter((s) => onSegment("me", s, Date.now())),
};

function broadcast(ev: Record<string, unknown>) {
  const s = JSON.stringify(ev);
  for (const ws of clients) ws.send(s);
}
const status = (message: string, level: "info" | "warn" | "error" = "info") => { log(`[${level}] ${message}`); broadcast({ type: "status", level, message }); };

// ---------- whisper-server ----------
let whisperProc: Subprocess | null = null;
let whisperUp = false;
async function whisperHealthy(): Promise<boolean> {
  try { const r = await fetch(`http://127.0.0.1:${WHISPER_PORT}/`, { signal: AbortSignal.timeout(1500) }); return r.status < 500; }
  catch { return false; }
}
async function ensureWhisper(): Promise<boolean> {
  if (await whisperHealthy()) { whisperUp = true; return true; }
  const bin = Bun.which("whisper-server");
  if (!bin) { status("whisper-server not found — run server/setup.sh", "error"); return false; }
  if (!existsSync(WHISPER_MODEL)) { status(`whisper model missing: ${WHISPER_MODEL} — run server/setup.sh`, "error"); return false; }
  const args = [bin, "-m", WHISPER_MODEL, "--host", "127.0.0.1", "--port", String(WHISPER_PORT), "-l", "auto", "-t", "8", "-nt", "--prompt", WHISPER_PROMPT_OVERRIDE ?? domainPrompt(jdText())];
  // Silero VAD trims the silence our own segmenter leaves at the edges, so whisper decodes less
  // audio per segment. Optional on purpose: a missing model costs latency, never the transcript.
  if (existsSync(VAD_MODEL)) args.push("--vad", "--vad-model", VAD_MODEL, "--vad-threshold", "0.5", "--vad-min-speech-duration-ms", "200", "--vad-min-silence-duration-ms", "300");
  else log(`VAD off (no model at ${VAD_MODEL}) — get it with: curl -L --fail -o ${VAD_MODEL} ${VAD_URL}`);
  log("starting whisper-server", WHISPER_MODEL);
  whisperProc = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 120; i++) { await Bun.sleep(500); if (await whisperHealthy()) { whisperUp = true; return true; } }
  status("whisper-server did not come up in 60s", "error");
  return false;
}

/** Whisper dying mid-interview is silent otherwise: audio keeps arriving and every segment fails.
 *  Restarts are capped because a model that cannot load will never load on the 30th try either. */
const restarts: number[] = [];
let restarting = false;
function watchWhisper() {
  setInterval(async () => {
    // `restarting` guards re-entry: ensureWhisper waits up to 60 s, several ticks long.
    if (!whisperUp || restarting || await whisperHealthy()) return;
    const now = Date.now();
    while (restarts.length && now - restarts[0]! > 300_000) restarts.shift();
    if (restarts.length >= 3) {
      whisperUp = false;                                  // stop trying: this is the cap, not a pause
      status("whisper-server went down 3 times in 5 minutes; no transcription unta reiniciar el sidecar", "error");
      return;
    }
    restarts.push(now);
    restarting = true;
    status(`whisper-server down; restarting (${restarts.length}/3)`, "warn");
    try { whisperProc?.kill(); } catch {}
    const ok = await ensureWhisper();
    restarting = false;                                   // a failed respawn still leaves the next attempt to the cap
    status(ok ? `whisper-server restarted on :${WHISPER_PORT}` : "whisper-server failed to restart", ok ? "info" : "error");
  }, 15_000);
}

async function transcribe(pcm: Int16Array): Promise<{ text: string; ms: number }> {
  const fd = new FormData();
  fd.append("file", new Blob([wavFromPcm16(pcm)], { type: "audio/wav" }), "seg.wav");
  fd.append("response_format", "json");
  fd.append("temperature", "0.0");
  const t0 = Date.now();
  const r = await fetch(`http://127.0.0.1:${WHISPER_PORT}/inference`, { method: "POST", body: fd, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`whisper ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as { text?: string };
  return { text: String(j.text ?? "").replace(/\s+/g, " ").trim(), ms: Date.now() - t0 };
}

// whisper-server handles one request at a time; serialize so segments never interleave.
let sttQueue: Promise<void> = Promise.resolve();
function onSegment(ch: Ch, seg: Segment, endedAt: number) {
  if (seg.peak < MIN_SEGMENT_PEAK) {
    // Cheaper than transcribing it and throwing the words away, and it keeps the log honest about
    // why nothing appeared.
    discarded[ch]++;
    log(`too quiet (${ch}): peak ${seg.peak.toFixed(4)} < ${MIN_SEGMENT_PEAK}`);
    return;
  }
  sttQueue = sttQueue.then(async () => {
    try {
      const { text, ms } = await transcribe(seg.pcm);
      if (isHallucination(text)) { discarded[ch]++; log(`discarded (${ch}): "${text}"`); broadcast({ type: "discard", ch, text }); return; }
      // Both channels, not just the microphone: with speakers on, our own cue comes back on the
      // INTERVIEWER channel, which is the one that triggers answers. Left unguarded the copilot
      // answers itself.
      const echo = echoOverlap(text, ch);
      if (echo.frac >= ECHO_THRESHOLD) {
        discarded[ch]++;
        log(`echo discarded (${ch}): "${text}" — ${Math.round(echo.frac * 100)}% matches ${echo.src}`);
        broadcast({ type: "discard", ch, text, reason: "echo" });
        return;
      }
      rememberSpoken(text, ch);
      const turn: Turn = { t: Date.now(), ch, text };
      segEndAt.set(turn, endedAt);
      if (ch === "them") sample("sttMs", ms);
      transcript.push(turn);
      broadcast({ type: "transcript", ...turn, sttMs: ms, durationMs: Math.round(seg.durationMs) });
      if (ch === "them" && settings.auto && looksLikeQuestion(text)) scheduleAnswer("answer", settings.effort, "auto");
    } catch (e) { status(`STT: ${(e as Error).message}`, "error"); }
  });
}

// ---------- brain scheduling: one call in flight, later triggers coalesce ----------
let answerTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;
let pending: { mode: Mode; effort: Effort } | null = null;

function scheduleAnswer(mode: Mode, effort: Effort, reason: string) {
  if (answerTimer) clearTimeout(answerTimer);
  // auto triggers wait 600ms so a follow-up sentence from the interviewer rides the same call
  answerTimer = setTimeout(() => runBrain(mode, effort, reason), reason === "auto" ? 600 : 0);
}

async function runBrain(mode: Mode, effort: Effort, reason: string) {
  if (inFlight) { pending = { mode, effort }; return; }
  // Claimed before the first await: two triggers landing in the same tick would otherwise both
  // pass the guard, and brain.ask rejects the second with "ya hay un turno en vuelo".
  inFlight = true;
  const t0 = Date.now();
  try {
    for (const s of Object.values(segmenters)) s.flush(); // "answer now" should include what is being said right now
    await sttQueue;
    const turns = transcript.slice(sentUpTo);
    const attachShot = !!latestShot && (mode === "solve" || shotDirty);
    if (!turns.length && !attachShot) { status("Nothing new to answer yet"); return; }
    const lastQuestion = [...turns].reverse().find((t) => t.ch === "them");
    // The clock starts when the interviewer stopped talking — but only for the automatic path.
    // A manual press can come minutes after that segment closed, and charging the wait to the
    // system reported a 40-second latency for a 3-second answer.
    const askedAt = reason === "auto" ? ((lastQuestion && segEndAt.get(lastQuestion)) ?? 0) : t0;
    broadcast({ type: "thinking", mode, effort, reason, turns: turns.length, shot: attachShot });
    let firstWordSeen = false;
    const res = await brain.ask({ turns, mode, effort, imagePath: attachShot ? latestShot!.path : undefined }, {
      onCueDelta: (chunk, cue) => {
        // First word out is when the candidate can open their mouth; the rest streams behind them.
        if (!firstWordSeen) { firstWordSeen = true; if (askedAt && mode === "answer") sample("qToFirstWordMs", Date.now() - askedAt); }
        broadcast({ type: "cue-delta", chunk, cue });
      },
      onCueDone: (cue) => {
        // The panel is about to speak this aloud. With speakers on it comes straight back in on
        // the interviewer channel, so remember it or the copilot answers its own suggestion.
        rememberSpoken(cue, "cue");
        broadcast({ type: "cue-done", cue });
        if (askedAt && mode === "answer") sample("qToVoiceMs", Date.now() - askedAt);
      },
    });
    sentUpTo += turns.length;
    if (attachShot) shotDirty = false;
    sample("firstTokenMs", res.firstTokenMs); sample("totalMs", res.totalMs);
    broadcast({ type: "answer", ...res, mode, effort, reason, ms: Date.now() - t0 });
    log(`answer ${mode}/${effort} ${Date.now() - t0}ms first-token=${res.firstTokenMs}ms model=${res.model} cue="${res.cue.slice(0, 60)}"`);
  } catch (e) {
    status(`Brain: ${(e as Error).message}`, "error");
  } finally {
    inFlight = false;
    if (pending) { const p = pending; pending = null; runBrain(p.mode, p.effort, "coalesced"); }
  }
}

// ---------- mock interviewer audio: `say` → ffmpeg → wav, cached by hash ----------
async function mockSay(text: string, voice: string): Promise<Response> {
  const safeVoice = voice.replace(/[^\w() -]/g, "").slice(0, 40) || "Samantha";
  const key = createHash("sha1").update(`${safeVoice}|${text}`).digest("hex").slice(0, 16);
  const wav = join(SHOT_DIR, `mock-${key}.wav`);
  if (!existsSync(wav)) {
    const aiff = join(SHOT_DIR, `mock-${key}.aiff`);
    const say = Bun.spawn(["say", "-v", safeVoice, "-o", aiff, text.slice(0, 500)], { stdout: "ignore", stderr: "pipe" });
    if ((await say.exited) !== 0) return new Response(`say failed: ${await new Response(say.stderr).text()}`, { status: 500 });
    const ff = Bun.spawn(["ffmpeg", "-y", "-loglevel", "error", "-i", aiff, "-ar", "44100", "-ac", "1", wav], { stdout: "ignore", stderr: "pipe" });
    if ((await ff.exited) !== 0) return new Response(`ffmpeg failed: ${await new Response(ff.stderr).text()}`, { status: 500 });
    unlinkSync(aiff);
  }
  return new Response(Bun.file(wav), { headers: { "content-type": "audio/wav", "cache-control": "no-store" } });
}

function pruneShots(keep = 40) {
  const files = readdirSync(SHOT_DIR).filter((f) => f.startsWith("shot-")).map((f) => join(SHOT_DIR, f))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
  for (const f of files.slice(0, Math.max(0, files.length - keep))) unlinkSync(f);
}

const json = (data: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(data), { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
const jdText = () => { const p = join(USER_DIR, "jd.md"); return existsSync(p) ? readFileSync(p, "utf8").replace(/^# Job \/ meeting context\s*/, "").trim() : ""; };
const state = () => ({ transcript: transcript.slice(-60), settings, latestShot, brain: brain.info(), inFlight, whisperPort: WHISPER_PORT, jd: jdText(), meters, discarded, latency: latency(), native: nativeStatus(), frontmostApp });
setInterval(() => {
  if (!clients.size) return;
  broadcast({ type: "meters", meters, discarded, used: brain.info().used });
  const l = latency();
  broadcast({ type: "latency", p50: l.p50, p95: l.p95 });
}, 500);

/** The one path from JPEG bytes to "this is the screen now" — used by the browser POST and by the
 *  native helper, so the two capture routes cannot drift. */
function saveShot(bytes: Uint8Array): string {
  const path = join(SHOT_DIR, `shot-${Date.now()}.jpg`);
  writeFileSync(path, bytes);
  latestShot = { path, t: Date.now() }; shotDirty = true;
  pruneShots();
  broadcast({ type: "shot", path, url: `/shots/${path.split("/").pop()}`, bytes: bytes.length });
  return path;
}

// ---------- native capture (Swift helper) ----------
// Frames from ScreenCaptureKit land in exactly the same places as the browser's: the same
// segmenters, the same meters, the same shot store. Everything downstream is unaware of which
// route the audio came from, which is the point — one pipeline, two front doors.
let frontmostApp: AppStatus | null = null;
const nativeHandlers = {
  onAudio: (ch: Ch, pcm: Int16Array) => {
    const m = meters[ch];
    if (!m.frames) { m.firstAt = Date.now(); log(`audio ${ch}: first native frame (${pcm.length} samples)`); }
    m.frames++; m.bytes += pcm.byteLength; m.lastAt = Date.now();
    const r = rmsOf(pcm);
    m.rms = m.rms * 0.8 + r * 0.2;
    m.peak = Math.max(m.peak * 0.95, r);
    segmenters[ch].push(pcm);
  },
  onShot: (jpeg: Uint8Array) => { if (jpeg.length >= 1000) saveShot(jpeg); },
  onStatus: (st: AppStatus) => {
    // Which app the candidate is actually working in. The brain gets it as context, and it is the
    // thing a shared browser tab could never tell us.
    const changed = frontmostApp?.bundleId !== st.bundleId;
    frontmostApp = st;
    if (changed) { log(`frontmost app: ${st.app}`); broadcast({ type: "app", ...st }); }
  },
  onLog: (line: string) => log(`[helper] ${line}`),
  onExit: (code: number | null, tccDenied: boolean) => {
    if (tccDenied) status("macOS denied Screen Recording or Microphone to the sidecar. Grant it in Settings → Privacy & Security and start again.", "error");
    else if (code) status(`The native capture exited with code ${code}`, "error");
    else status("Native capture stopped");
    broadcast({ type: "native", ...nativeStatus() });
  },
};

// ---------- HTTP + WS ----------
const server = Bun.serve<WsData>({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req, srv) {
    const url = new URL(req.url);
    const p = url.pathname;
    // Voice owns /voice/*, and serves its own client script. Mounted first so it never
    // collides with the panel's routes.
    const voiceRes = await handleVoiceRequest(req, p);
    if (voiceRes) return voiceRes;
    if (p === "/audio" || p === "/events") {
      return srv.upgrade(req, { data: { kind: p.slice(1) as WsData["kind"] } }) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    if (req.method === "GET") {
      if (p === "/") return new Response(Bun.file(join(ROOT, "panel.html")), { headers: { "content-type": "text/html; charset=utf-8" } });
      if (p === "/mock") return new Response(Bun.file(join(ROOT, "mock.html")), { headers: { "content-type": "text/html; charset=utf-8" } });
      if (p === "/mock/say") return mockSay(url.searchParams.get("text") ?? "", url.searchParams.get("voice") ?? "Samantha");
      if (p === "/health") return json({ ok: true, whisper: await whisperHealthy(), ...state() });
      if (p === "/state") return json(state());
      if (p === "/native/status") return json(nativeStatus());
      if (p === "/native/sources") return json(await listSources());
      if (p.startsWith("/shots/")) { const f = join(SHOT_DIR, p.slice(7).replace(/[^\w.-]/g, "")); return existsSync(f) ? new Response(Bun.file(f)) : new Response("no", { status: 404 }); }
      return new Response("not found", { status: 404 });
    }
    if (req.method === "POST") {
      if (p === "/shot") {
        const bytes = new Uint8Array(await req.arrayBuffer());
        if (bytes.length < 1000) return json({ ok: false, error: "empty" }, { status: 400 });
        return json({ ok: true, path: saveShot(bytes) });
      }
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      if (p === "/native/start") {
        const r = startNative({
          fps: typeof body.fps === "number" ? body.fps : 1,
          display: typeof body.display === "number" ? body.display : undefined,
          mic: body.mic !== false, audio: body.audio !== false, screen: body.screen !== false,
        }, nativeHandlers);
        if (r.ok) status("Native capture started: system audio, microphone and screen, no picker");
        broadcast({ type: "native", ...nativeStatus() });
        return json(r.ok ? { ok: true, ...nativeStatus() } : { ok: false, error: r.error }, { status: r.ok ? 200 : 409 });
      }
      if (p === "/native/stop") { stopNative(); broadcast({ type: "native", ...nativeStatus() }); return json({ ok: true }); }
      if (p === "/answer-now") {
        const mode: Mode = body.mode === "solve" ? "solve" : "answer";
        const effort: Effort = body.effort === "deep" ? "deep" : settings.effort;
        if (mode === "solve" && !latestShot) return json({ ok: false, error: "No screenshot yet: turn on a capture source first" }, { status: 409 });
        scheduleAnswer(mode, effort, "manual");
        return json({ ok: true });
      }
      if (p === "/context") {
        const jd = String(body.jd ?? "").trim();
        writeFileSync(join(USER_DIR, "jd.md"), jd ? `# Job / meeting context\n\n${jd}\n` : "");
        brain.reset();
        status(jd ? "Context saved; the brain starts a fresh session" : "Context cleared; the brain starts a fresh session");
        return json({ ok: true, brain: brain.info() });
      }
      if (p === "/settings") {
        if (typeof body.auto === "boolean") settings.auto = body.auto;
        if (body.effort === "quick" || body.effort === "deep") settings.effort = body.effort;
        broadcast({ type: "settings", ...settings });
        return json({ ok: true, settings });
      }
      if (p === "/reset") {
        brain.reset(); brain.warm();   // re-warm now, so the next question does not pay the boot
        transcript.length = 0; sentUpTo = 0; latestShot = null; shotDirty = false;
        broadcast({ type: "reset", brain: brain.info() });
        return json({ ok: true });
      }
      if (p === "/tts") {
        const text = String(body.text ?? "").slice(0, 450);
        if (!text) return json({ ok: false }, { status: 400 });
        try {
          const r = await fetch(PULSE_NOTIFY, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Interview AI", message: text, voice_id: body.voice_id ?? undefined }), signal: AbortSignal.timeout(8000) });
          return json({ ok: r.ok, status: r.status });
        } catch (e) { return json({ ok: false, error: `Pulse is not responding: ${(e as Error).message}` }, { status: 502 }); }
      }
      return new Response("not found", { status: 404 });
    }
    return new Response("method", { status: 405 });
  },
  websocket: {
    open(ws) {
      if (ws.data.kind === "events") { clients.add(ws); ws.send(JSON.stringify({ type: "state", ...state() })); }
    },
    message(ws, msg) {
      if (ws.data.kind !== "audio" || typeof msg === "string") return;
      const bytes = msg as Uint8Array;
      if (bytes.byteLength < 4) return;
      const ch: Ch = bytes[0] === 1 ? "me" : "them";
      let pcm: Int16Array;
      try {
        // Address the incoming view directly. `bytes.slice(2).buffer` looked like a copy but
        // Bun's Buffer.slice is subarray, so .buffer handed back the whole pool: a garbage
        // leading sample today, and out-of-bounds reads the moment Bun pools receive buffers.
        pcm = new Int16Array(bytes.buffer, bytes.byteOffset + 2, (bytes.byteLength - 2) >> 1);
      } catch (e) { status(`Unreadable audio frame: ${(e as Error).message}`, "error"); return; }
      const m = meters[ch];
      if (!m.frames) { m.firstAt = Date.now(); log(`audio ${ch}: first frame (${pcm.length} samples)`); }
      m.frames++; m.bytes += bytes.byteLength; m.lastAt = Date.now();
      const r = rmsOf(pcm);
      m.rms = m.rms * 0.8 + r * 0.2;          // smoothed, for the level meter
      m.peak = Math.max(m.peak * 0.95, r);    // decaying peak, so a single word still registers
      segmenters[ch].push(pcm);
    },
    close(ws) { clients.delete(ws); },
  },
});

const priorShots = readdirSync(SHOT_DIR).filter((f) => f.startsWith("shot-")).sort();
if (priorShots.length) {
  const path = join(SHOT_DIR, priorShots[priorShots.length - 1]);
  latestShot = { path, t: statSync(path).mtimeMs };
}

log(`Interview AI sidecar → http://127.0.0.1:${server.port}  (mock interviewer: /mock)`);
log(`brain: ${JSON.stringify(brain.info())}`);
ensureWhisper().then((ok) => {
  status(ok ? `whisper-server ready on :${WHISPER_PORT}${existsSync(VAD_MODEL) ? " (VAD on)" : " (VAD off)"}` : "no transcription: whisper-server unavailable", ok ? "info" : "error");
  // The ~2.4 s `claude` boot is paid here, on an empty room, instead of on the first real question.
  brain.warm();
  log("brain: process pre-warmed");
  if (ok) watchWhisper();
});

// brain.kill() matters now that warm() holds a `claude` open: without it every restart orphans one.
const shutdown = () => {
  stopNative(); for (const s of Object.values(segmenters)) s.flush(); brain.kill(); whisperProc?.kill(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
