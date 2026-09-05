// voice.ts — the cue's voice. ElevenLabs when a key exists, the browser's own when it does not.
//   GET  /voice/health     provider, key present, model, ws url, last error
//   GET  /voice/voices     the account's voices (cached 5 min), or [] and the reason why
//   GET  /voice/speak      what the streaming endpoint is and where (the stream itself is a WS)
//   GET  /voice-client.js  the browser half, so wiring this in is one line in server.ts
//   GET  /voice/test       voice-test.html, the verification surface
//   WS   ws://127.0.0.1:<IAI_VOICE_PORT>/voice/speak   text clauses up, PCM down
//
// Why a WebSocket and not chunked HTTP. The panel speaks the cue clause by clause while the
// brain is still writing it, so the transport has to carry text up and audio down at the same
// time. A browser cannot do that over HTTP: a streamed request body needs `duplex: "half"`,
// and "half" is the whole problem — the response does not begin until the request body ends.
// One WebSocket keeps the property the panel is built on.
//
// Why its own port. This module owns three new files and edits none. Upgrading on the sidecar's
// port would mean adding dispatch into server.ts's websocket.open/message/close handlers; a
// second listener on 127.0.0.1 costs one line here instead.
//
// The API key is read here and never leaves the process — the browser talks to this relay, the
// relay talks to ElevenLabs. Anything that fails says so in JSON and the panel drops to
// speechSynthesis; nothing in this file can make the cue silent.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ServerWebSocket } from "bun";

const ROOT = dirname(import.meta.path);
const KEY = process.env.ELEVENLABS_API_KEY ?? "";
const VOICE_PORT = Number(process.env.IAI_VOICE_PORT ?? 31339);
// Flash is the only tier that fits: ~75 ms model latency against a ~880 ms first token, 32
// languages including Spanish, and half the credit cost of multilingual v2. v3 is better
// sounding and cannot be used here at all — it has no plain TTS websocket.
const MODEL = process.env.IAI_ELEVEN_MODEL ?? "eleven_flash_v2_5";
// Headerless PCM: every chunk is independently decodable, so the panel schedules them straight
// onto an AudioContext with no MediaSource and no container parsing. 24 kHz stays under the
// 44.1 kHz PCM gate that needs a Pro subscription.
const FORMAT = process.env.IAI_ELEVEN_FORMAT ?? "pcm_24000";
const RATE = Number(/pcm_(\d+)/.exec(FORMAT)?.[1] ?? 24000);
const VOICE_ID_ENV = process.env.IAI_ELEVEN_VOICE_ID ?? "";
const API = "https://api.elevenlabs.io";

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), "[voice]", ...a);
const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });

type Voice = { voice_id: string; name: string; category?: string; labels?: Record<string, string>; languages?: string[] };
let voicesCache: { at: number; voices: Voice[] } | null = null;
let lastError = "";

const NO_KEY = "No ELEVENLABS_API_KEY: add the line to ~/.config/PAI/.env and restart the sidecar.";

/** Synchronous by contract, so it reports the cached voice list rather than fetching one. */
export function voiceHealth(): {
  provider: "elevenlabs" | "browser";
  keyPresent: boolean;
  model?: string;
  format?: string;
  rate?: number;
  wsUrl?: string;
  voices?: Voice[];
  lastError?: string;
} {
  if (!KEY) return { provider: "browser", keyPresent: false, lastError: lastError || NO_KEY };
  ensureVoiceServer();
  return {
    provider: "elevenlabs",
    keyPresent: true,
    model: MODEL,
    format: FORMAT,
    rate: RATE,
    wsUrl: `ws://127.0.0.1:${VOICE_PORT}/voice/speak`,
    voices: voicesCache?.voices,
    ...(lastError ? { lastError } : {}),
  };
}

// ---------- voices ----------
async function listVoices(): Promise<{ voices: Voice[]; reason?: string }> {
  if (!KEY) return { voices: [], reason: NO_KEY };
  if (voicesCache && Date.now() - voicesCache.at < 300_000) return { voices: voicesCache.voices };
  try {
    const r = await fetch(`${API}/v2/voices?page_size=100`, { headers: { "xi-api-key": KEY }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) {
      lastError = `ElevenLabs /v2/voices → ${r.status} ${(await r.text()).slice(0, 200)}`;
      return { voices: [], reason: lastError };
    }
    const body = (await r.json()) as { voices?: Voice[] };
    voicesCache = { at: Date.now(), voices: body.voices ?? [] };
    lastError = "";
    return { voices: voicesCache.voices };
  } catch (e) {
    lastError = `ElevenLabs no responde: ${(e as Error).message}`;
    return { voices: [], reason: lastError };
  }
}

/** No invented voice ids. Either the principal named one, or we take the account's own list and
 *  prefer a voice that actually claims the cue's language. */
async function resolveVoiceId(lang: string): Promise<string> {
  if (VOICE_ID_ENV) return VOICE_ID_ENV;
  const { voices, reason } = await listVoices();
  if (!voices.length) throw new Error(reason ?? "la cuenta no tiene voces");
  const want = (lang || "en").slice(0, 2).toLowerCase();
  const claims = (v: Voice) =>
    JSON.stringify(v.labels ?? {}).toLowerCase().includes(want === "es" ? "spanish" : "english") ||
    (v.languages ?? []).some((l) => l.toLowerCase().startsWith(want));
  return (voices.find(claims) ?? voices[0]!).voice_id;
}

// ---------- the relay ----------
type Session = { el: WebSocket | null; opened: boolean; buffer: string[]; ending: boolean; gen: number };
const sessions = new WeakMap<ServerWebSocket<unknown>, Session>();
let voiceServer: ReturnType<typeof Bun.serve> | null = null;

function reply(ws: ServerWebSocket<unknown>, o: Record<string, unknown>) {
  try { ws.send(JSON.stringify(o)); } catch {}
}

/** Open the ElevenLabs socket for one cue and pump it. Text the panel pushed before the socket
 *  finished opening is buffered here — those first clauses are the whole point of the exercise. */
async function beginCue(ws: ServerWebSocket<unknown>, lang: string, voiceId?: string) {
  const s = sessions.get(ws);
  if (!s) return;
  const gen = ++s.gen;
  closeEl(s);
  s.opened = false; s.buffer = []; s.ending = false;
  let id: string;
  try { id = voiceId || (await resolveVoiceId(lang)); }
  catch (e) { reply(ws, { type: "error", error: (e as Error).message }); return; }
  if (s.gen !== gen) return;                                  // cancelled while resolving the voice

  const q = new URLSearchParams({
    model_id: MODEL,
    output_format: FORMAT,
    // The panel already sends whole clauses, so the model has nothing to gain from buffering
    // them further; auto_mode generates on each message and drops the chunk schedule.
    auto_mode: "true",
    inactivity_timeout: "20",
  });
  if (lang) q.set("language_code", lang.slice(0, 2).toLowerCase());
  const url = `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(id)}/stream-input?${q}`;
  // Header auth, not the `authorization` query param: a key in a URL ends up in every log line
  // that touches it. Bun's WebSocket client accepts an options object here; browsers cannot,
  // which is the other reason this relay exists. The cast is only because the DOM lib's
  // constructor signature knows about subprotocols and nothing else.
  const el = new WebSocket(url, { headers: { "xi-api-key": KEY } } as unknown as string[]);
  s.el = el;

  el.addEventListener("open", () => {
    if (s.gen !== gen) { try { el.close(); } catch {} return; }
    s.opened = true;
    el.send(JSON.stringify({
      text: " ",
      voice_settings: { stability: 0.4, similarity_boost: 0.75, speed: 1.05 },
    }));
    for (const t of s.buffer) el.send(JSON.stringify({ text: t }));
    s.buffer = [];
    if (s.ending) el.send(JSON.stringify({ text: "" }));
    reply(ws, { type: "rate", rate: RATE });
  });
  el.addEventListener("message", (ev) => {
    if (s.gen !== gen) return;
    let m: { audio?: string | null; isFinal?: boolean; error?: string; message?: string };
    try { m = JSON.parse(String((ev as MessageEvent).data)); } catch { return; }
    if (m.error || (m.message && !m.audio)) {
      lastError = String(m.error ?? m.message);
      reply(ws, { type: "error", error: lastError });
      return;
    }
    if (m.audio) { try { ws.send(Buffer.from(m.audio, "base64")); } catch {} }
    if (m.isFinal) reply(ws, { type: "end" });
  });
  el.addEventListener("error", () => {
    if (s.gen !== gen) return;
    // The close event carries the real reason (401, 1008 quota…); this fires first and blind.
    lastError = lastError || "the ElevenLabs connection failed";
    reply(ws, { type: "error", error: lastError });
  });
  el.addEventListener("close", (ev) => {
    if (s.gen !== gen) return;
    const c = ev as CloseEvent;
    if (c.code && c.code !== 1000) {
      lastError = `ElevenLabs cerró: ${c.code} ${c.reason || ""}`.trim();
      reply(ws, { type: "error", error: lastError });
    }
  });
}

function closeEl(s: Session) {
  if (!s.el) return;
  try { s.el.close(1000); } catch {}
  s.el = null;
}

function ensureVoiceServer() {
  if (voiceServer || !KEY) return;
  try {
    voiceServer = Bun.serve({
      port: VOICE_PORT,
      hostname: "127.0.0.1",
      fetch(req, srv) {
        if (new URL(req.url).pathname === "/voice/speak" && srv.upgrade(req, { data: {} })) return undefined;
        return new Response("voice relay", { status: 426 });
      },
      websocket: {
        open(ws) { sessions.set(ws, { el: null, opened: false, buffer: [], ending: false, gen: 0 }); },
        message(ws, raw) {
          const s = sessions.get(ws);
          if (!s || typeof raw !== "string") return;
          let m: { type?: string; text?: string; lang?: string; voiceId?: string };
          try { m = JSON.parse(raw); } catch { return; }
          if (m.type === "begin") { beginCue(ws, m.lang ?? "", m.voiceId); return; }
          if (m.type === "push") {
            const t = String(m.text ?? "");
            if (!t.trim()) return;
            if (s.opened && s.el) s.el.send(JSON.stringify({ text: t }));
            else s.buffer.push(t);
            return;
          }
          if (m.type === "end") {
            s.ending = true;
            if (s.opened && s.el) s.el.send(JSON.stringify({ text: "" }));
            return;
          }
          if (m.type === "cancel") { s.gen++; closeEl(s); s.buffer = []; s.ending = false; }
        },
        close(ws) { const s = sessions.get(ws); if (s) { s.gen++; closeEl(s); } },
      },
    });
    log(`relay en ws://127.0.0.1:${VOICE_PORT}/voice/speak (${MODEL}, ${FORMAT})`);
  } catch (e) {
    lastError = `no pude abrir el puerto ${VOICE_PORT}: ${(e as Error).message}`;
    log(lastError);
  }
}

// ---------- HTTP ----------
/** Returns null for anything that is not ours, so server.ts can fall through to its own routes. */
export async function handleVoiceRequest(req: Request, pathname: string): Promise<Response | null> {
  if (req.method !== "GET") return null;
  if (pathname === "/voice/health") return json(voiceHealth());
  if (pathname === "/voice/voices") {
    const { voices, reason } = await listVoices();
    return json({ voices, ...(reason ? { reason } : {}) });
  }
  if (pathname === "/voice/speak") {
    // The stream itself is a WebSocket on another port; this is the discovery answer, and the
    // honest error when there is no key to open one with.
    const h = voiceHealth();
    return h.keyPresent
      ? json({ transport: "websocket", wsUrl: h.wsUrl, model: MODEL, format: FORMAT, rate: RATE })
      : json({ transport: "none", reason: h.lastError }, { status: 503 });
  }
  if (pathname === "/voice-client.js") return file("voice-client.js", "text/javascript; charset=utf-8");
  if (pathname === "/voice/test") return file("voice-test.html", "text/html; charset=utf-8");
  return null;
}

function file(name: string, type: string): Response {
  const p = join(ROOT, name);
  return existsSync(p)
    ? new Response(Bun.file(p), { headers: { "content-type": type, "cache-control": "no-store" } })
    : new Response(`missing ${name}`, { status: 404 });
}

// Bring the relay up with the process, not with the first cue: opening a socket is ~100 ms the
// candidate would otherwise pay in the middle of the first answer.
ensureVoiceServer();
