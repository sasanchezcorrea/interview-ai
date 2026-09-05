// native.ts — runs the Swift capture helper and turns its byte stream into the same events the
// browser path produces, so everything downstream (segmenter, whisper, brain, panel) is unchanged.
//
// Why this exists: the Chrome path makes the user pick a surface in a picker and tick an
// easily-missed "share audio" checkbox. Missing it costs the whole session — video flows, no
// transcript, and the failure looks like the app being broken. ScreenCaptureKit has no picker and
// no checkbox: system audio and microphone arrive as two separate taps on one stream, and it also
// reports which application is frontmost, which a shared browser tab never could.
//
// Wire format from the helper (helper/README.md is the contract):
//   header 6 bytes — [0]=0x49 'I', [1]=kind, [2..5]=uint32 LE payload length
//   kind 0 system audio · 1 microphone — both PCM Int16 LE, 16 kHz mono
//   kind 2 JPEG screenshot · 3 UTF-8 JSON status {app,bundleId,title,t}
// stderr is log lines only, never mixed into stdout.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Subprocess } from "bun";

const ROOT = dirname(import.meta.path);
export const HELPER_BIN = process.env.IAI_HELPER_BIN ?? join(ROOT, "..", "helper", ".build", "release", "iai-capture");
const MAGIC = 0x49;
/** A JPEG at native Retina resolution is a few hundred KB; anything past this is a desync. */
const MAX_PAYLOAD = 32 * 1024 * 1024;
/** The helper exits 13 when macOS refused Screen Recording or Microphone. */
export const TCC_DENIED = 13;

export interface AppStatus { app: string; bundleId: string; title: string; t: number }
export interface NativeHandlers {
  onAudio(ch: "them" | "me", pcm: Int16Array): void;
  onShot(jpeg: Uint8Array): void;
  onStatus(s: AppStatus): void;
  onLog(line: string): void;
  onExit(code: number | null, tccDenied: boolean): void;
}
export interface NativeOptions { fps?: number; display?: number; mic?: boolean; audio?: boolean; screen?: boolean }

let proc: Subprocess | null = null;
let startedAt = 0;
let lastError = "";
let frontmost: AppStatus | null = null;
const counts = { audio: 0, mic: 0, shots: 0, status: 0 };

export function nativeAvailable(): { built: boolean; path: string } {
  return { built: existsSync(HELPER_BIN), path: HELPER_BIN };
}

export function nativeStatus() {
  return {
    available: nativeAvailable().built,
    running: !!proc && proc.exitCode === null,
    startedAt: startedAt || null,
    frontmost,
    counts: { ...counts },
    lastError: lastError || undefined,
    path: HELPER_BIN,
  };
}

/** Displays and running apps, straight from the helper. Cheap: it prints JSON and exits. */
export async function listSources(): Promise<{ displays: unknown[]; applications: unknown[] } | { error: string }> {
  if (!nativeAvailable().built) return { error: `helper not built: ${HELPER_BIN} (run: cd helper && swift build -c release)` };
  const p = Bun.spawn([HELPER_BIN, "--list"], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  const code = await p.exited;
  if (code !== 0) return { error: `--list exited ${code}: ${(await new Response(p.stderr).text()).slice(0, 300)}` };
  try { return JSON.parse(out); } catch { return { error: `--list returned unparseable JSON: ${out.slice(0, 200)}` }; }
}

export function stopNative(): void {
  if (!proc) return;
  // SIGINT, not SIGKILL: the helper tears the SCStream down cleanly on interrupt, and a killed
  // capture leaves the OS thinking the screen is still being recorded.
  try { proc.kill("SIGINT"); } catch {}
  proc = null;
  startedAt = 0;
}

export function startNative(opts: NativeOptions, h: NativeHandlers): { ok: boolean; error?: string } {
  if (proc && proc.exitCode === null) return { ok: true };
  const { built } = nativeAvailable();
  if (!built) return { ok: false, error: `helper not built: ${HELPER_BIN} (run: cd helper && swift build -c release)` };

  const args: string[] = [];
  if (opts.fps) args.push("--fps", String(opts.fps));
  if (typeof opts.display === "number") args.push("--display", String(opts.display));
  if (opts.mic === false) args.push("--no-mic");
  if (opts.audio === false) args.push("--no-audio");
  if (opts.screen === false) args.push("--no-screen");

  lastError = "";
  counts.audio = counts.mic = counts.shots = counts.status = 0;
  startedAt = Date.now();
  proc = Bun.spawn([HELPER_BIN, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });

  readFrames(proc, h).catch((e) => { lastError = (e as Error).message; h.onLog(`native reader: ${lastError}`); });
  readLines(proc, h);

  proc.exited.then((code) => {
    const denied = code === TCC_DENIED;
    if (denied) lastError = "macOS denied Screen Recording or Microphone to this process";
    else if (code) lastError = `helper exited ${code}`;
    proc = null; startedAt = 0;
    h.onExit(code, denied);
  });
  return { ok: true };
}

async function readLines(p: Subprocess, h: NativeHandlers): Promise<void> {
  const reader = (p.stderr as ReadableStream<Uint8Array>).getReader();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += new TextDecoder().decode(value);
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (line) h.onLog(line);
    }
  }
}

/** Reassembles frames across chunk boundaries — a payload never arrives whole. */
async function readFrames(p: Subprocess, h: NativeHandlers): Promise<void> {
  const reader = (p.stdout as ReadableStream<Uint8Array>).getReader();
  let buf = new Uint8Array(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf = concat(buf, value);
    for (;;) {
      if (buf.length < 6) break;
      if (buf[0] !== MAGIC) {
        // Desync: hunt for the next magic byte rather than throwing away the whole stream.
        const next = buf.indexOf(MAGIC, 1);
        h.onLog(`native: lost frame sync, resyncing (${next < 0 ? "no magic in buffer" : `skipped ${next} bytes`})`);
        buf = next < 0 ? new Uint8Array(0) : buf.subarray(next);
        continue;
      }
      const kind = buf[1];
      const len = new DataView(buf.buffer, buf.byteOffset + 2, 4).getUint32(0, true);
      if (len > MAX_PAYLOAD) { h.onLog(`native: implausible payload ${len} bytes, resyncing`); buf = buf.subarray(1); continue; }
      if (buf.length < 6 + len) break;
      const payload = buf.subarray(6, 6 + len);
      try { dispatch(kind, payload, h); }
      catch (e) { h.onLog(`native: dropped a ${len}-byte kind-${kind} frame: ${(e as Error).message}`); }
      buf = buf.subarray(6 + len);
    }
  }
}

function dispatch(kind: number, payload: Uint8Array, h: NativeHandlers): void {
  switch (kind) {
    case 0:
    case 1: {
      if (payload.length < 2) return;
      // A payload lands wherever the previous frame left off, so its byteOffset is odd half the
      // time and Int16Array refuses to view it ("Byte offset is not aligned"). Aligned: view it in
      // place. Odd: copy, which is the only correct option and costs one memcpy per frame.
      const pcm = payload.byteOffset % 2 === 0
        ? new Int16Array(payload.buffer, payload.byteOffset, payload.length >> 1)
        : new Int16Array(new Uint8Array(payload).buffer, 0, payload.length >> 1);
      if (kind === 0) counts.audio++; else counts.mic++;
      h.onAudio(kind === 0 ? "them" : "me", pcm);
      return;
    }
    case 2:
      counts.shots++;
      h.onShot(new Uint8Array(payload));   // copy: the caller writes it to disk asynchronously
      return;
    case 3: {
      counts.status++;
      try {
        const s = JSON.parse(new TextDecoder().decode(payload)) as AppStatus;
        frontmost = s;
        h.onStatus(s);
      } catch { h.onLog("native: unparseable status frame"); }
      return;
    }
    default:
      h.onLog(`native: unknown frame kind ${kind}`);
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (!a.length) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a); out.set(b, a.length);
  return out;
}
