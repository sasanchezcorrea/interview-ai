#!/usr/bin/env bun
// bench-stt.ts — measures whisper.cpp transcription quality/latency across model + VAD + prompt
// configs against a golden fixture set, so the live server's model/flag choice is a measured
// decision instead of a guess. Mirrors server.ts's own whisper-server invocation and /inference
// call so the numbers here reflect what production would actually see.
//
// Usage: bun server/bench-stt.ts [--models small,medium] [--fixtures /tmp/interview-ai/fixtures] [--json]
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { domainPrompt } from "./audio";

// ---------- CLI ----------
function argVal(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const MODELS = (argVal("--models") ?? "small,medium").split(",").map((s) => s.trim()).filter(Boolean);
const FIXTURES_DIR = argVal("--fixtures") ?? "/tmp/interview-ai/fixtures";
const JSON_OUT = process.argv.includes("--json");

// Never 8178 — that's the live server's own whisper-server (server.ts), and this script may run
// while an interview is live.
const BENCH_PORT = 8179;
const CACHE_DIR = join(homedir(), ".cache/whisper");
const VAD_MODEL = join(CACHE_DIR, "ggml-silero-v5.1.2.bin");
const HF_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

// Exercises the real domainPrompt() helper (the one server.ts's agent calls from a job description)
// rather than hand-rolling a second hardcoded prompt string just for this bench.
const SAMPLE_JD =
  // A Spanish job description on purpose: word error rate on Spanish technical jargon is the
// thing this bench was built to measure, and it cannot be measured in English.
"Buscamos Senior AI Engineer con experiencia en agentes MCP, Kubernetes multi-tenant, pipelines RAG con embeddings, y orquestación con LangGraph.";
const PROMPT_TEXT = domainPrompt(SAMPLE_JD);

// The exact loanword set TASK 2's fixtures were built to cover — the hit-rate axis of the bench.
const DOMAIN_TERMS = ["MCP", "Kubernetes", "RAG", "embeddings", "multi-tenant", "LangGraph"];

const log = (...a: unknown[]) => console.error("[bench]", ...a); // status noise on stderr so --json stdout stays parseable

// ---------- fixtures ----------
interface Fixture { name: string; wav: string; expected: string }
function loadFixtures(dir: string): Fixture[] {
  if (!existsSync(dir)) throw new Error(`fixtures dir not found: ${dir}`);
  const names = readdirSync(dir).filter((f) => f.endsWith(".wav")).map((f) => f.slice(0, -4)).sort();
  return names.map((name) => ({
    name,
    wav: join(dir, `${name}.wav`),
    expected: readFileSync(join(dir, `${name}.txt`), "utf8").trim(),
  }));
}

// ---------- scoring: normalize, then plain Levenshtein over word arrays (no deps) ----------
function normalize(text: string): string {
  return text
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // strip accents: café → cafe
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
const wordsOf = (text: string): string[] => { const n = normalize(text); return n ? n.split(" ") : []; };
const flatOf = (text: string): string => normalize(text).replace(/\s+/g, ""); // for domain-term substring checks: "Lang Graph" ~= "LangGraph"

function levenshtein(a: string[], b: string[]): number {
  const dp = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) dp[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!; dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j]!, dp[j - 1]!);
      prev = tmp;
    }
  }
  return dp[b.length]!;
}
/** Word-level WER = edit distance / reference length. Can exceed 100% (hypothesis all insertions). */
function wer(ref: string, hyp: string): number {
  const r = wordsOf(ref), h = wordsOf(hyp);
  if (r.length === 0) return h.length === 0 ? 0 : 1;
  return levenshtein(r, h) / r.length;
}

// ---------- model download (only if a requested size is missing) ----------
async function ensureModel(size: string): Promise<string | null> {
  const path = join(CACHE_DIR, `ggml-${size}.bin`);
  if (existsSync(path)) return path;
  const tmp = `${path}.part`;
  log(`${size}: model missing, downloading ggml-${size}.bin ...`);
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const r = await fetch(`${HF_BASE}/ggml-${size}.bin`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    await Bun.write(tmp, r);
    // Real ggml files start with magic 0x67676d6c stored little-endian (bytes 6c 6d 67 67) —
    // catches an HTML error page saved under the right name.
    const head = new Uint8Array(await Bun.file(tmp).slice(0, 4).arrayBuffer());
    if (!(head[0] === 0x6c && head[1] === 0x6d && head[2] === 0x67 && head[3] === 0x67)) {
      throw new Error("downloaded file is not a valid ggml model (bad magic bytes)");
    }
    renameSync(tmp, path);
    return path;
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    log(`${size}: download failed (${(e as Error).message}) — skipping ${size} rows`);
    return null;
  }
}

// ---------- whisper-server lifecycle (mirrors server.ts's ensureWhisper) ----------
async function whisperHealthy(): Promise<boolean> {
  try { const r = await fetch(`http://127.0.0.1:${BENCH_PORT}/`, { signal: AbortSignal.timeout(1500) }); return r.status < 500; }
  catch { return false; }
}
async function startWhisper(modelPath: string, opts: { vad: boolean; prompt: boolean }): Promise<Subprocess> {
  // Guards the exact bug this bench hit once already: a leftover process on BENCH_PORT (ours or
  // a stray one) makes every subsequent config silently re-measure whatever is already listening.
  if (await whisperHealthy()) throw new Error(`something is already listening on :${BENCH_PORT} — kill it before benching`);
  const bin = Bun.which("whisper-server");
  if (!bin) throw new Error("whisper-server not found on PATH — run server/setup.sh");
  const args = [bin, "-m", modelPath, "--host", "127.0.0.1", "--port", String(BENCH_PORT), "-l", "auto", "-t", "8", "-nt"];
  if (opts.prompt) args.push("--prompt", PROMPT_TEXT);
  if (opts.vad) args.push("--vad", "--vad-model", VAD_MODEL, "--vad-threshold", "0.5", "--vad-min-speech-duration-ms", "200", "--vad-min-silence-duration-ms", "300");
  const proc = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 120; i++) {
    if (await whisperHealthy()) return proc;
    await Bun.sleep(500);
  }
  try { proc.kill(); } catch {}
  throw new Error(`whisper-server (${modelPath}) did not come up in 60s on :${BENCH_PORT}`);
}

async function transcribe(wavPath: string): Promise<{ text: string; ms: number }> {
  const fd = new FormData();
  fd.append("file", new Blob([await Bun.file(wavPath).arrayBuffer()], { type: "audio/wav" }), "seg.wav");
  fd.append("response_format", "json");
  fd.append("temperature", "0.0");
  const t0 = performance.now();
  const r = await fetch(`http://127.0.0.1:${BENCH_PORT}/inference`, { method: "POST", body: fd, signal: AbortSignal.timeout(30_000) });
  const ms = performance.now() - t0;
  if (!r.ok) throw new Error(`whisper ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as { text?: string };
  return { text: String(j.text ?? "").replace(/\s+/g, " ").trim(), ms };
}

// ---------- one config = one model + vad on/off + prompt on/off, run over every fixture ----------
interface ConfigResult {
  model: string; vad: boolean; prompt: boolean;
  avgWerPct: number; avgMs: number; p95Ms: number;
  domainHits: number; domainTotal: number;
  perFixture: { name: string; werPct: number; ms: number; text: string; expected: string }[];
}

async function runConfig(size: string, modelPath: string, vad: boolean, prompt: boolean, fixtures: Fixture[]): Promise<ConfigResult> {
  let proc: Subprocess | null = null;
  const perFixture: ConfigResult["perFixture"] = [];
  try {
    proc = await startWhisper(modelPath, { vad, prompt });
    for (const f of fixtures) {
      const { text, ms } = await transcribe(f.wav);
      perFixture.push({ name: f.name, werPct: wer(f.expected, text) * 100, ms, text, expected: f.expected });
    }
  } finally {
    // Await full exit, not just the kill signal: the next config binds the same port immediately,
    // and a whisper-server still mid-shutdown (Metal buffer teardown etc.) loses that bind race —
    // the old process keeps answering and every later config silently re-measures the first one.
    if (proc) { try { proc.kill(); } catch {} try { await proc.exited; } catch {} }
  }
  const avgWerPct = perFixture.reduce((s, p) => s + p.werPct, 0) / (perFixture.length || 1);
  const lats = perFixture.map((p) => p.ms).sort((a, b) => a - b);
  const avgMs = lats.reduce((s, v) => s + v, 0) / (lats.length || 1);
  const p95Ms = lats.length ? lats[Math.min(lats.length - 1, Math.ceil(0.95 * lats.length) - 1)]! : 0;
  let domainHits = 0, domainTotal = 0;
  for (const p of perFixture) {
    const refFlat = flatOf(p.expected), hypFlat = flatOf(p.text);
    for (const term of DOMAIN_TERMS) {
      const tf = flatOf(term);
      if (refFlat.includes(tf)) { domainTotal++; if (hypFlat.includes(tf)) domainHits++; }
    }
  }
  return { model: size, vad, prompt, avgWerPct, avgMs, p95Ms, domainHits, domainTotal, perFixture };
}

async function main() {
  const fixtures = loadFixtures(FIXTURES_DIR);
  if (!fixtures.length) throw new Error(`no fixtures (*.wav + matching *.txt) found in ${FIXTURES_DIR}`);
  log(`${fixtures.length} fixtures from ${FIXTURES_DIR}`);

  const results: ConfigResult[] = [];
  const skippedModels: string[] = [];
  const vadAvailable = existsSync(VAD_MODEL);
  if (!vadAvailable) log(`VAD model missing at ${VAD_MODEL} — skipping vad=on rows`);

  for (const size of MODELS) {
    const modelPath = await ensureModel(size);
    if (!modelPath) { skippedModels.push(size); continue; }
    for (const vad of vadAvailable ? [false, true] : [false]) {
      for (const prompt of [false, true]) {
        log(`running model=${size} vad=${vad} prompt=${prompt} ...`);
        results.push(await runConfig(size, modelPath, vad, prompt, fixtures));
      }
    }
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ fixturesDir: FIXTURES_DIR, skippedModels, results }, null, 2));
    return;
  }

  console.table(results.map((r) => ({
    model: r.model,
    vad: r.vad ? "on" : "off",
    prompt: r.prompt ? "on" : "off",
    avgWER: `${r.avgWerPct.toFixed(1)}%`,
    domainHitRate: r.domainTotal ? `${Math.round((r.domainHits / r.domainTotal) * 100)}% (${r.domainHits}/${r.domainTotal})` : "n/a",
    avgLatencyMs: Math.round(r.avgMs),
    p95LatencyMs: Math.round(r.p95Ms),
  })));

  if (skippedModels.length) console.log(`\nskipped (model unavailable): ${skippedModels.join(", ")}`);
  if (results.length) {
    const best = [...results].sort((a, b) => a.avgWerPct - b.avgWerPct)[0]!;
    console.log(
      `\nlowest WER: model=${best.model} vad=${best.vad ? "on" : "off"} prompt=${best.prompt ? "on" : "off"}` +
      ` — WER ${best.avgWerPct.toFixed(1)}%, domain hit ${best.domainTotal ? Math.round((best.domainHits / best.domainTotal) * 100) : 0}%, avg ${Math.round(best.avgMs)}ms`
    );
  }
}

main().catch((e) => { console.error("[bench] fatal:", e); process.exit(1); });
