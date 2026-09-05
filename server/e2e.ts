#!/usr/bin/env bun
// server/e2e.ts — end-to-end harness for Interview AI. Drives REAL Chrome (CDP over plain
// WebSocket, no puppeteer) through the actual capture buttons with trusted input events, so it
// exercises pipePCM() and every other function the in-panel `?test=1` autotest bypasses by
// reimplementing the audio pipe inline. Twenty green tests on code that never ran is the bug this
// file exists to make structurally impossible: every row below is measured from the server's own
// /events stream or /health, never from a shortcut re-implementation.
//
// Usage: bun server/e2e.ts [--surface=tab|screen|both] [--keep-open] [--json]
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Subprocess } from "bun";

const ROOT = dirname(import.meta.path);
const PORT = Number(process.env.IAI_PORT ?? 31338);
const SIDECAR = `http://127.0.0.1:${PORT}`;
const EVENTS_WS = `ws://127.0.0.1:${PORT}/events`;
const MOCK_URL = `${SIDECAR}/mock`;
const PANEL_URL = `${SIDECAR}/`;
const CDP_PORT = 9333;
const CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// Must exactly match mock.html's <title>, so --auto-select-tab-capture-source-by-title picks that
// tab (and only that tab — panel.html's title "Interview AI" is a substring of this one, not the
// reverse, so matching on the full string never mis-picks the panel itself).
const MOCK_TITLE = "Mock interviewer · Interview AI";
// Verbatim copies of mock.html's QS[0] and QS[1] — used for word-overlap scoring against the
// whisper transcript, so the strings must match exactly what /mock/say actually speaks.
const QUESTIONS = [
  "Hi, thanks for joining. To start, tell me about yourself and your experience building AI agents in production.",
  "How would you design a multi-tenant RAG system where tenants must never see each other's data?",
];

const log = (...a: unknown[]) => console.error(new Date().toISOString().slice(11, 19), ...a);

// ---------- shared types ----------
interface Row { name: string; pass: boolean; detail: string }
interface Meter { frames: number; bytes: number; rms: number; peak: number; lastAt: number; firstAt: number; dropped: number }
interface HealthState { ok: boolean; whisper: boolean; meters: { them: Meter; me: Meter }; [k: string]: unknown }
interface EventRec { t: number; ev: Record<string, unknown> & { type?: string } }

// ---------- small utils ----------
async function health(): Promise<HealthState> {
  const r = await fetch(`${SIDECAR}/health`);
  if (!r.ok) throw new Error(`GET /health -> HTTP ${r.status}`);
  return (await r.json()) as HealthState;
}

async function pollUntil<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs: number, intervalMs = 250): Promise<{ ok: boolean; value: T }> {
  const t0 = Date.now();
  let value = await fn();
  while (!ok(value) && Date.now() - t0 < timeoutMs) {
    await Bun.sleep(intervalMs);
    value = await fn();
  }
  return { ok: ok(value), value };
}

/** Strip accents/punctuation, drop short filler words, so overlap counts reflect real content words. */
function normalizeWords(s: string): string[] {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2);
}
function wordOverlapCount(question: string, transcript: string): number {
  const qWords = new Set(normalizeWords(question));
  const seen = new Set<string>();
  for (const w of normalizeWords(transcript)) if (qWords.has(w)) seen.add(w);
  return seen.size;
}

async function ensureSidecar(): Promise<void> {
  if (await fetch(`${SIDECAR}/health`).then((r) => r.ok).catch(() => false)) return;
  const proc = Bun.spawn(["bash", join(ROOT, "start.sh")], { stdout: "inherit", stderr: "inherit", stdin: "ignore" });
  await proc.exited; // start.sh already waits for whisper (or times out); we only need /health after
  const t0 = Date.now();
  while (Date.now() - t0 < 30_000) {
    if (await fetch(`${SIDECAR}/health`).then((r) => r.ok).catch(() => false)) return;
    await Bun.sleep(500);
  }
  throw new Error(`${SIDECAR}/health never came up after running start.sh`);
}

async function waitForCdp(timeoutMs = 15_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((r) => r.ok).catch(() => false)) return;
    await Bun.sleep(200);
  }
  throw new Error(`Chrome DevTools Protocol never came up on :${CDP_PORT}`);
}

async function buildFakeMicWav(dir: string): Promise<string> {
  const aiff = join(dir, "mic.aiff");
  const wav = join(dir, "mic-16k.wav");
  // Real speech, on-topic with the whisper prompt's domain vocabulary, so the "me" channel gets a
  // genuine transcript instead of testing the fake-audio plumbing against noise.
  const text = "I have three years of experience building multi tenant AI agent systems in production with Kubernetes, Python, and MCP tools.";
  const say = Bun.spawn(["say", "-o", aiff, text], { stdout: "ignore", stderr: "pipe" });
  if ((await say.exited) !== 0) throw new Error(`say failed: ${await new Response(say.stderr).text()}`);
  const ff = Bun.spawn(["ffmpeg", "-y", "-loglevel", "error", "-i", aiff, "-ar", "16000", "-ac", "1", wav], { stdout: "ignore", stderr: "pipe" });
  if ((await ff.exited) !== 0) throw new Error(`ffmpeg failed: ${await new Response(ff.stderr).text()}`);
  return wav;
}

function launchChrome(profileDir: string, wavPath: string): Subprocess {
  if (!existsSync(CHROME_BIN)) throw new Error(`Chrome not found at ${CHROME_BIN}`);
  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--use-fake-ui-for-media-stream",
    `--use-file-for-fake-audio-capture=${wavPath}`,
    `--auto-select-tab-capture-source-by-title=${MOCK_TITLE}`,
    "--auto-select-desktop-capture-source=Entire screen",
    "--window-size=1360,900",
    // Deliberately NOT --autoplay-policy=no-user-gesture-required: that would mask a
    // suspended-AudioContext bug real users would hit (see pipePCM's comment in panel.html).
    "about:blank",
  ];
  return Bun.spawn([CHROME_BIN, ...args], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
}

// ---------- /events recorder: the assertion source of truth ----------
class EventRecorder {
  events: EventRec[] = [];
  private ws!: WebSocket;
  private waiters: { predicate: (r: EventRec) => boolean; resolve: (r: EventRec | null) => void }[] = [];

  constructor(private url: string) {}

  async connect(): Promise<void> {
    this.ws = new WebSocket(this.url);
    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error(`events WS failed to connect: ${this.url}`));
    });
    this.ws.onmessage = (m: { data: unknown }) => {
      let ev: Record<string, unknown>;
      try { ev = JSON.parse(String(m.data)); } catch { return; }
      const rec: EventRec = { t: Date.now(), ev };
      this.events.push(rec);
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        if (this.waiters[i].predicate(rec)) { const w = this.waiters[i]; this.waiters.splice(i, 1); w.resolve(rec); }
      }
    };
  }

  /** Resolves with the first matching event at/after `sinceT`, from history or as it arrives; null on timeout. */
  waitFor(predicate: (ev: Record<string, unknown>) => boolean, timeoutMs: number, sinceT = 0): Promise<EventRec | null> {
    const existing = this.events.find((r) => r.t >= sinceT && predicate(r.ev));
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.resolve === wrapped);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      const wrapped = (r: EventRec | null) => { clearTimeout(timer); resolve(r); };
      this.waiters.push({ predicate: (r) => r.t >= sinceT && predicate(r.ev), resolve: wrapped });
    });
  }

  close(): void { try { this.ws.close(); } catch {} }
}

/** Combines a transcript wait with continuous /health RMS sampling over the same window, so "mean
 *  RMS while the question plays" is measured over the actual play-to-transcript window, not a guess. */
async function waitTranscriptWithRms(recorder: EventRecorder, ch: "them" | "me", sinceT: number, timeoutMs: number): Promise<{ rec: EventRec | null; mean: number }> {
  const samples: number[] = [];
  const iv = setInterval(() => { health().then((h) => samples.push(h.meters[ch].rms)).catch(() => {}); }, 250);
  const rec = await recorder.waitFor((ev) => ev.type === "transcript" && ev.ch === ch, timeoutMs, sinceT);
  clearInterval(iv);
  const mean = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
  return { rec, mean };
}

// ---------- CDP: plain WebSocket JSON-RPC, no puppeteer ----------
interface CdpEvalResult<T> { result: { value?: T }; exceptionDetails?: { exception?: { description?: string } } }

class CDP {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(private url: string) {}

  async connect(): Promise<void> {
    this.ws = new WebSocket(this.url);
    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error(`CDP WS failed to connect: ${this.url}`));
    });
    this.ws.onmessage = (m: { data: unknown }) => {
      let msg: { id?: number; result?: unknown; error?: { message: string } };
      try { msg = JSON.parse(String(m.data)); } catch { return; }
      if (msg.id == null) return; // CDP protocol *events* (Page.*, Network.*...) — unused, we only issue commands
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    };
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      // 30s, not 15s: a live run showed the panel's main thread (continuous ScriptProcessorNode
      // audio callbacks across two simultaneous pipes) can leave CDP unanswered past 15s under load.
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30_000);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v as T); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void { try { this.ws.close(); } catch {} }
}

async function evaluate<T = unknown>(cdp: CDP, expression: string): Promise<T> {
  const res = await cdp.send<CdpEvalResult<T>>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) throw new Error(`page eval threw: ${res.exceptionDetails.exception?.description ?? JSON.stringify(res.exceptionDetails)}`);
  return res.result?.value as T;
}

async function elementCenter(cdp: CDP, elementExpr: string): Promise<{ x: number; y: number } | null> {
  return evaluate(cdp, `(() => { const el = ${elementExpr}; if (!el) return null; el.scrollIntoView({block:"center", inline:"center"}); const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) return null; return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
}

/** A real Input.dispatchMouseEvent click — trusted, carries user activation. A Runtime.evaluate
 *  `el.click()` does NOT, and getDisplayMedia/getUserMedia would refuse it. */
async function clickAt(cdp: CDP, x: number, y: number): Promise<void> {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 1, clickCount: 1 });
}
async function clickSelector(cdp: CDP, selector: string): Promise<void> {
  const c = await elementCenter(cdp, `document.querySelector(${JSON.stringify(selector)})`);
  if (!c) throw new Error(`selector not found or zero-size: ${selector}`);
  await clickAt(cdp, c.x, c.y);
}
async function clickNth(cdp: CDP, selector: string, index: number): Promise<void> {
  const c = await elementCenter(cdp, `document.querySelectorAll(${JSON.stringify(selector)})[${index}]`);
  if (!c) throw new Error(`selector[${index}] not found or zero-size: ${selector}`);
  await clickAt(cdp, c.x, c.y);
}
/** Bring the tab forward first: input dispatched to a backgrounded tab is real, but the "user
 *  activation" plumbing behind getDisplayMedia is one less variable if the tab is actually frontmost. */
async function focusedClick(cdp: CDP, selector: string): Promise<void> { await cdp.send("Page.bringToFront"); await clickSelector(cdp, selector); }
async function focusedClickNth(cdp: CDP, selector: string, index: number): Promise<void> { await cdp.send("Page.bringToFront"); await clickNth(cdp, selector, index); }

async function waitForLoad(cdp: CDP, timeoutMs = 15_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if ((await evaluate<string>(cdp, "document.readyState")) === "complete") return; } catch {}
    await Bun.sleep(150);
  }
  throw new Error("page did not reach readyState=complete in time");
}

async function openTab(url: string): Promise<CDP> {
  let res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${url}`, { method: "PUT" }).catch(() => null);
  if (!res || !res.ok) res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${url}`, { method: "GET" });
  if (!res.ok) throw new Error(`CDP /json/new failed for ${url}: HTTP ${res.status}`);
  const info = (await res.json()) as { webSocketDebuggerUrl?: string };
  if (!info.webSocketDebuggerUrl) throw new Error(`CDP /json/new response for ${url} missing webSocketDebuggerUrl`);
  const cdp = new CDP(info.webSocketDebuggerUrl);
  await cdp.connect();
  await waitForLoad(cdp);
  return cdp;
}

// panel.html's inline <script> is classic (non-module): its `const S = {...}` is a script-scope
// binding, NOT window.S — `window.S` is always undefined. Bare `S` resolves correctly from
// Runtime.evaluate (same shared global lexical environment DevTools console uses), so every
// snippet below references bare `S`/`stopSource`/`takeShot`, never `window.<name>`.
const STOP_THEM_JS = `if (typeof stopSource === "function" && typeof S !== "undefined" && S.streams && S.streams.them) stopSource("them");`;

async function waitForStream(panel: CDP, ch: "them" | "me", timeoutMs: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const has = await evaluate<boolean>(panel, `typeof S !== "undefined" && !!(S.streams && S.streams['${ch}'])`);
    if (has) return true;
    await Bun.sleep(150);
  }
  return false;
}

interface PanelDiag { trackCount: number; displaySurface: string | null; ctxState: string | null }
async function panelDiag(panel: CDP, ch: "them" | "me"): Promise<PanelDiag> {
  return evaluate<PanelDiag>(panel, `(() => {
    if (typeof S === "undefined") return { trackCount: 0, displaySurface: null, ctxState: null };
    const s = S.streams ? S.streams['${ch}'] : null;
    const p = S.pipes ? S.pipes['${ch}'] : null;
    const audioTracks = s ? s.getAudioTracks() : [];
    const videoTracks = s ? s.getVideoTracks() : [];
    return {
      trackCount: audioTracks.length,
      displaySurface: videoTracks[0] ? (videoTracks[0].getSettings().displaySurface || null) : null,
      ctxState: (p && p.ctx) ? p.ctx.state : null,
    };
  })()`);
}

// ---------- test rows ----------
function surfaceSkipRows(surface: string, reason: string): Row[] {
  return ["audio_track", "display_surface", "audiocontext_running", "shot", "frames_them", "rms_them", "transcript_them", "first_token", "answer"]
    .map((n) => ({ name: `${surface}:${n}`, pass: false, detail: `skipped: ${reason}` }));
}

async function testSurface(surface: "tab" | "screen", mock: CDP, panel: CDP, recorder: EventRecorder): Promise<Row[]> {
  const btn = surface === "tab" ? "#b-tab" : "#b-screen";
  const expectedSurface = surface === "tab" ? "browser" : "monitor";

  await evaluate(panel, STOP_THEM_JS); // #b-tab/#b-screen share one "them" slot — clear it before switching
  await Bun.sleep(300);
  const tStart = Date.now();
  try { await focusedClick(panel, btn); }
  catch (e) { return surfaceSkipRows(surface, `click ${btn} failed: ${(e as Error).message}`); }

  const gotStream = await waitForStream(panel, "them", 6000);
  if (!gotStream) return surfaceSkipRows(surface, `no 'them' MediaStream within 6s of clicking ${btn} (picker likely shown instead of auto-selected, or permission denied)`);

  const rows: Row[] = [];
  const diag = await panelDiag(panel, "them");
  rows.push({ name: `${surface}:audio_track`, pass: diag.trackCount === 1, detail: `getAudioTracks().length=${diag.trackCount}` });
  rows.push({ name: `${surface}:display_surface`, pass: diag.displaySurface === expectedSurface, detail: `expected=${expectedSurface} actual=${diag.displaySurface}` });
  rows.push({ name: `${surface}:audiocontext_running`, pass: diag.ctxState === "running", detail: `ctx.state=${diag.ctxState}` });

  const [shotRec, framesResult] = await Promise.all([
    recorder.waitFor((ev) => ev.type === "shot", 10_000, tStart),
    (async () => {
      const framesStart = (await health()).meters.them.frames;
      return pollUntil(async () => (await health()).meters.them.frames - framesStart, (n) => n > 50, 10_000);
    })(),
  ]);
  rows.push({ name: `${surface}:shot`, pass: !!shotRec, detail: shotRec ? `arrived +${shotRec.t - tStart}ms` : "no 'shot' event within 10s" });
  rows.push({ name: `${surface}:frames_them`, pass: framesResult.ok, detail: `frames_delta=${framesResult.value} (need >50 within 10s)` });

  const qIndex = surface === "tab" ? 0 : 1;
  const question = QUESTIONS[qIndex];
  const tQ = Date.now();
  try { await focusedClickNth(mock, "#qs button", qIndex); }
  catch (e) {
    const reason = `could not trigger question: ${(e as Error).message}`;
    rows.push({ name: `${surface}:rms_them`, pass: false, detail: reason });
    rows.push({ name: `${surface}:transcript_them`, pass: false, detail: `skipped: ${reason}` });
    rows.push({ name: `${surface}:first_token`, pass: false, detail: `skipped: ${reason}` });
    rows.push({ name: `${surface}:answer`, pass: false, detail: `skipped: ${reason}` });
    return rows;
  }

  const { rec: transcriptRec, mean: meanRms } = await waitTranscriptWithRms(recorder, "them", tQ, 15_000);
  rows.push({ name: `${surface}:rms_them`, pass: meanRms > 0.005, detail: `mean_rms=${meanRms.toFixed(4)} while waiting for transcript` });
  const overlap = transcriptRec ? wordOverlapCount(question, String(transcriptRec.ev.text ?? "")) : 0;
  rows.push({
    name: `${surface}:transcript_them`, pass: !!transcriptRec && overlap >= 4,
    detail: transcriptRec ? `overlap=${overlap}/4 text="${String(transcriptRec.ev.text).slice(0, 80)}"` : "no 'them' transcript within 15s",
  });

  if (transcriptRec) {
    const cueDelta = await recorder.waitFor((ev) => ev.type === "cue-delta", 3000, transcriptRec.t);
    rows.push({
      name: `${surface}:first_token`, pass: !!cueDelta,
      detail: cueDelta ? `arrived +${cueDelta.t - transcriptRec.t}ms after transcript` : "no 'cue-delta' event within 3s of transcript (event may not exist yet)",
    });
  } else {
    rows.push({ name: `${surface}:first_token`, pass: false, detail: "skipped: no transcript to anchor on" });
  }

  const answerRec = await recorder.waitFor((ev) => ev.type === "answer" && typeof ev.cue === "string" && (ev.cue as string).trim().length > 0, 25_000, tQ);
  rows.push({
    name: `${surface}:answer`, pass: !!answerRec,
    detail: answerRec ? `arrived +${answerRec.t - tQ}ms cue="${String(answerRec.ev.cue).slice(0, 60)}"` : "no non-empty 'answer' event within 25s",
  });

  return rows;
}

async function testMic(panel: CDP, recorder: EventRecorder): Promise<Row> {
  try {
    const tStart = Date.now();
    await focusedClick(panel, "#b-mic");
    const got = await waitForStream(panel, "me", 6000);
    if (!got) return { name: "mic_transcript", pass: false, detail: "getUserMedia never resolved a 'me' MediaStream within 6s" };
    const rec = await recorder.waitFor((ev) => ev.type === "transcript" && ev.ch === "me", 20_000, tStart);
    return { name: "mic_transcript", pass: !!rec, detail: rec ? `arrived +${rec.t - tStart}ms text="${String(rec.ev.text).slice(0, 80)}"` : "no 'me' transcript within 20s" };
  } catch (e) {
    return { name: "mic_transcript", pass: false, detail: `threw: ${(e as Error).message}` };
  }
}

async function testSolve(mock: CDP, panel: CDP, recorder: EventRecorder): Promise<Row> {
  try {
    await focusedClick(mock, "#toggle-problem"); // reveal the exercise while a capture is still live, so the next shot shows it
    await evaluate(panel, `(async () => { if (typeof takeShot === "function") await takeShot(true); })()`);
    await Bun.sleep(800);
    const tClick = Date.now();
    await focusedClick(panel, "#b-solve");
    const rec = await recorder.waitFor((ev) => ev.type === "answer" && ev.mode === "solve", 40_000, tClick);
    if (!rec) {
      const statusText = await evaluate<string>(panel, `document.getElementById("status")?.textContent || ""`).catch(() => "");
      return { name: "solve_code", pass: false, detail: `no solve 'answer' within 40s (panel status: "${statusText}")` };
    }
    const body = String((rec.ev.code as { body?: string } | undefined)?.body ?? "");
    const lines = body ? body.split("\n").length : 0;
    return { name: "solve_code", pass: lines > 5, detail: `code.body lines=${lines}` };
  } catch (e) {
    return { name: "solve_code", pass: false, detail: `threw: ${(e as Error).message}` };
  }
}

/** Simulates "shared a surface without its audio" deterministically (rather than depending on a
 *  flaky OS/Chrome-version-specific absence of system audio): swap in a canvas-only fake stream
 *  (video track, zero audio tracks) for one click, so pipePCM's `no-track` branch is exercised for real. */
async function testHonestUi(panel: CDP): Promise<Row> {
  try {
    await evaluate(panel, STOP_THEM_JS);
    await Bun.sleep(200);
    await evaluate(panel, `(() => {
      window.__origGDM = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getDisplayMedia = async () => {
        const c = document.createElement("canvas"); c.width = 2; c.height = 2;
        return c.captureStream(1); // video-only stream: reproduces "shared a surface without its audio"
      };
    })()`);
    await focusedClick(panel, "#b-tab");
    await Bun.sleep(1200);
    const state = await evaluate<string>(panel, `document.getElementById("b-tab")?.dataset.state || ""`);
    const hasNotice = await evaluate<boolean>(panel, `!!document.getElementById("no-audio")`);
    await evaluate(panel, STOP_THEM_JS);
    await evaluate(panel, `if (window.__origGDM) navigator.mediaDevices.getDisplayMedia = window.__origGDM;`);
    const pass = state !== "live" && hasNotice;
    return { name: "honest_ui_no_audio", pass, detail: `#b-tab data-state="${state}" (must not be "live"), #no-audio present=${hasNotice}` };
  } catch (e) {
    return { name: "honest_ui_no_audio", pass: false, detail: `threw: ${(e as Error).message}` };
  }
}

function computeLatencyRow(recorder: EventRecorder): Row {
  const vals = recorder.events.filter((r) => r.ev.type === "latency" && typeof r.ev.qToVoiceMs === "number").map((r) => r.ev.qToVoiceMs as number);
  if (!vals.length) return { name: "latency_budget_p95", pass: false, detail: "no 'latency' events observed (event may not exist yet)" };
  vals.sort((a, b) => a - b);
  const p95 = vals[Math.min(vals.length - 1, Math.ceil(0.95 * vals.length) - 1)];
  return { name: "latency_budget_p95", pass: p95 <= 2500, detail: `p95=${p95}ms over n=${vals.length} samples` };
}

async function safeRun(label: string, fn: () => Promise<Row[]>): Promise<Row[]> {
  try { return await fn(); }
  catch (e) { return [{ name: label, pass: false, detail: `threw: ${(e as Error).message}` }]; }
}

function printTable(rows: Row[]): void {
  if (!rows.length) { console.log("no rows ran"); return; }
  const w = Math.max(...rows.map((r) => r.name.length));
  for (const r of rows) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(w)}  ${r.detail}`);
  console.log(`\n${rows.filter((r) => r.pass).length}/${rows.length} passed`);
}

// ---------- main ----------
let activeCleanup: (() => Promise<void>) | null = null;
process.on("SIGINT", async () => { await activeCleanup?.(); process.exit(130); });
process.on("SIGTERM", async () => { await activeCleanup?.(); process.exit(143); });

async function main(): Promise<void> {
  const argv: string[] = process.argv.slice(2);
  const surfaceArgRaw = argv.find((a: string) => a.startsWith("--surface="))?.split("=")[1] ?? "both";
  if (!["tab", "screen", "both"].includes(surfaceArgRaw)) { console.error(`bad --surface value: ${surfaceArgRaw}`); process.exit(2); }
  const surfaceArg = surfaceArgRaw as "tab" | "screen" | "both";
  const keepOpen = argv.includes("--keep-open");
  const jsonOut = argv.includes("--json");

  const scratch = mkdtempSync(join(tmpdir(), "iai-e2e-"));
  const profileDir = join(scratch, "chrome-profile");
  mkdirSync(profileDir, { recursive: true });

  let chrome: Subprocess | null = null;
  let recorder: EventRecorder | null = null;
  const sessions: CDP[] = [];
  const rows: Row[] = [];

  const cleanup = async () => {
    for (const s of sessions) s.close();
    recorder?.close();
    if (chrome && !keepOpen) { try { chrome.kill("SIGKILL"); } catch {} try { await chrome.exited; } catch {} }
    if (!keepOpen) { try { rmSync(scratch, { recursive: true, force: true }); } catch {} }
  };
  activeCleanup = cleanup;

  try {
    log("checking sidecar...");
    await ensureSidecar();

    log("connecting to /events...");
    recorder = new EventRecorder(EVENTS_WS);
    await recorder.connect();

    log("building fake mic audio...");
    const wavPath = await buildFakeMicWav(scratch);

    log("launching Chrome...");
    chrome = launchChrome(profileDir, wavPath);
    await waitForCdp();

    const mockTab = await openTab(MOCK_URL); sessions.push(mockTab);
    const panelTab = await openTab(PANEL_URL); sessions.push(panelTab);

    rows.push(...await safeRun("honest_ui_no_audio", async () => [await testHonestUi(panelTab)]));

    const surfaces: ("tab" | "screen")[] = surfaceArg === "both" ? ["tab", "screen"] : [surfaceArg];
    for (let i = 0; i < surfaces.length; i++) {
      const surface = surfaces[i];
      rows.push(...await safeRun(`${surface}:surface`, () => testSurface(surface, mockTab, panelTab, recorder!)));
      if (i === 0) {
        // mirror the human flow: mic + solve run once, right after the first capture path, while
        // its shot is still fresh — matches steps 6-7 of the spec, before "repeat for screen" (step 8)
        rows.push(...await safeRun("mic_transcript", async () => [await testMic(panelTab, recorder!)]));
        rows.push(...await safeRun("solve_code", async () => [await testSolve(mockTab, panelTab, recorder!)]));
      }
    }
    rows.push(...await safeRun("latency_budget_p95", async () => [computeLatencyRow(recorder!)]));
  } catch (e) {
    rows.push({ name: "harness", pass: false, detail: `fatal: ${(e as Error).message}` });
  } finally {
    await cleanup();
  }

  if (jsonOut) console.log(JSON.stringify({ rows }, null, 2));
  else printTable(rows);
  process.exit(rows.some((r) => !r.pass) ? 1 : 0);
}

await main();
