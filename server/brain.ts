#!/usr/bin/env bun
// brain.ts — asks Claude (subscription) what the candidate should say next, fast enough to be usable.
//
// Two measured decisions drive this file:
//   1. Spawning `claude` per turn cost ~2.4 s of process boot before the model saw a token. One
//      long-lived process fed by `--input-format stream-json` pays that once, and keeps the
//      conversation without --resume. Measured: turn 1 3015 ms, later turns 2269 ms.
//   2. Waiting for a whole JSON object meant nothing on screen for 8 s. With
//      `--include-partial-messages` the first token lands at 734-1164 ms, so the cue is written
//      and spoken while it generates.
// Output is therefore line-oriented, not JSON: the cue is the FIRST line so it can stream and be
// spoken clause by clause. A JSON object is only usable once it closes.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Effort = "quick" | "deep";
export type Mode = "answer" | "solve";
export interface Turn { t: number; ch: "them" | "me"; text: string }
export interface Answer {
  cue: string; points: string[]; code: { lang: string; body: string } | null;
  model: string; firstTokenMs: number; totalMs: number; degraded?: string;
}
export interface StreamHandlers {
  onCueDelta?(chunk: string, cueSoFar: string): void;
  onCueDone?(cue: string): void;
}

const models = await import(join(homedir(), ".claude/LIFEOS/TOOLS/models.ts")).catch(() => null);
const MODEL: Record<Effort, string> = {
  quick: models?.modelForEffort?.("medium") ?? "sonnet",
  deep: models?.modelForEffort?.("high") ?? "opus",
};
const TIMEOUT_MS: Record<Effort, number> = { quick: 30_000, deep: 90_000 };
const resolveClaudeBin = () => Bun.which("claude") ?? join(homedir(), ".local/bin/claude");
const readIfExists = (p: string) => (existsSync(p) ? readFileSync(p, "utf8").trim() : "");

export class Brain {
  private proc: ChildProcess | null = null;
  private buf = "";                                   // stdout line buffer
  private turn: {
    resolve: (a: Answer) => void; reject: (e: Error) => void;
    handlers: StreamHandlers; started: number; firstToken: number;
    text: string; cueDone: boolean; timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private turns = 0;
  private lastError = "";

  /** Session totals, so the candidate can see what a call actually costs. Survives brain.reset():
   *  what was spent was spent, and a fresh conversation does not refund it. */
  private used = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, calls: 0 };

  constructor(private paths: { dossierPath: string; jdPath: string }) {}

  info() {
    return {
      alive: !!this.proc && !this.proc.killed, turns: this.turns, models: MODEL,
      dossier: existsSync(this.paths.dossierPath), jd: existsSync(this.paths.jdPath),
      used: { ...this.used },
      lastError: this.lastError || undefined,
    };
  }

  /** The `result` event closes a turn and carries its token counts. Cache reads are billed
   *  differently from fresh input, so they are kept apart instead of summed into one number. */
  private recordUsage(ev: any): void {
    const u = ev?.usage; if (!u) return;
    this.used.input += u.input_tokens ?? 0;
    this.used.output += u.output_tokens ?? 0;
    this.used.cacheRead += u.cache_read_input_tokens ?? 0;
    this.used.cacheWrite += u.cache_creation_input_tokens ?? 0;
    this.used.costUsd += ev.total_cost_usd ?? 0;
    this.used.calls++;
  }

  /** New conversation: new job context, or the candidate pressed "nueva ronda". */
  reset() { this.kill(); this.turns = 0; this.lastError = ""; }
  kill() { try { this.proc?.kill("SIGTERM"); } catch {} this.proc = null; this.buf = ""; this.failTurn("session restarted"); }
  private failTurn(why: string) {
    if (!this.turn) return;
    clearTimeout(this.turn.timer);
    const t = this.turn; this.turn = null;
    t.reject(new Error(why));
  }

  systemPrompt(): string {
    const dossier = readIfExists(this.paths.dossierPath) || "(no dossier yet — run /interview-ai:prep; answer from general best practice and say so)";
    const jd = readIfExists(this.paths.jdPath) || "(no job description provided)";
    return `You are Interview AI, a real-time copilot for a candidate in a live job interview or technical meeting.
You receive the live transcript (THEM = interviewer(s); ME = the candidate) and sometimes a screenshot of what is on screen.
Your only job: give the candidate the best thing to say next, grounded in their real background (dossier).

FORMAT — plain text, in this exact order, no preamble, no markdown headings, no JSON:
Line 1: the cue. What to say RIGHT NOW: ONE sentence, 12-22 words, first person, natural spoken
        language, in the SAME language the interviewer used. No quotes, no "You could say". It is
        spoken aloud as it streams, so front-load the substance: the first six words must already
        carry the answer, because the candidate starts talking before the line finishes. Never a
        list, never two sentences. Detail belongs in the "- " lines, not here.
Then:   0-5 lines each starting with "- ", the substance to expand with. ALWAYS in the same
        language as line 1, even when the dossier is written in another language.
Then:   only when a coding task is asked or visible, a fenced code block with its language tag,
        containing complete runnable code with a one-line comment naming the approach and complexity.

RULES
- ANSWER mode only: if the latest THEM turn is not a question and needs no reply, line 1 is
  exactly: (nada). In SOLVE mode never answer (nada) — the task is whatever the screenshot shows,
  and a missing or unreadable screenshot is itself worth saying out loud.
- Never invent experience missing from the dossier. If the candidate lacks it, the cue says so
  honestly and pivots to the closest real experience.
- ANONYMISE the dossier. Never say an employer, product, client, repository, ticket, PR number or
  internal codename out loud — the interviewer does not know them, and naming them sounds like
  leaking. Describe the system by its SHAPE and SCALE instead: "a multi-tenant RAG platform",
  "a production voice agent", "a 48-service internal platform". The engineering is the evidence;
  the brand name is not, and often breaks a confidentiality expectation.
- SENIOR DEPTH, not breadth. A list of technologies is a junior answer. Each "- " line carries one
  of: the mechanism (how it actually works), the trade-off taken and what was given up, the failure
  mode it prevents, or a measurable outcome. Prefer three lines that stand up to a follow-up over
  five that only name things. Assume the very next question is "why?" and pre-answer it.
- AGNOSTIC BY DEFAULT. Answer from general engineering principle, not from the candidate's
  employer, its products, its stack choices or the way that one company happened to do it. The
  answer must stand on its own for any team. Bring the candidate's own history in ONLY when the
  interviewer explicitly asks for experience ("tell me about a time", "have you done X",
  "walk me through a project"), and even then anonymised and as evidence for the principle you
  already stated — never as the opening move, never as the reason something is true.
- The candidate speaks the cue themselves. Never address the interviewer, never mention that a
  copilot exists.
- One concrete example beats three adjectives.
- Use the Read tool ONLY when the message gives you a file path to read. Never otherwise.

CANDIDATE DOSSIER:
${dossier}

JOB / MEETING CONTEXT:
${jd}`;
  }

  private spawnProc(): ChildProcess {
    const env = { ...process.env } as Record<string, string | undefined>;
    // Billing stays on the subscription: both of these outrank the OAuth token in Claude's
    // credential precedence, and Bun auto-loads ~/.claude/.env into children.
    delete env.CLAUDECODE; delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN; delete env.ANTHROPIC_BASE_URL;
    const proc = spawn(resolveClaudeBin(), [
      "--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--include-partial-messages", "--model", MODEL.quick, "--effort", "medium",
      "--setting-sources", "", "--exclude-dynamic-system-prompt-sections",
      "--allowedTools", "Read",              // needed for screenshots; the prompt forbids other use
      "--system-prompt", this.systemPrompt(),
    ], { env, stdio: ["pipe", "pipe", "pipe"] });
    proc.stdout!.setEncoding("utf8");
    proc.stdout!.on("data", (d: string) => this.onStdout(d));
    proc.on("exit", (code) => {
      this.proc = null;
      if (this.turn) { this.lastError = `the process died (code ${code})`; this.failTurn(this.lastError); }
    });
    proc.on("error", (e) => { this.lastError = e.message; this.proc = null; this.failTurn(e.message); });
    return proc;
  }

  /** Start the process before the first question so its ~2.4 s boot never lands on a turn. */
  warm() { if (!this.proc) this.proc = this.spawnProc(); }

  private onStdout(chunk: string) {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl); this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let ev: any;
      try { ev = JSON.parse(line); } catch { continue; }
      this.onEvent(ev);
    }
  }

  private onEvent(ev: any) {
    const t = this.turn; if (!t) return;
    if (ev.type === "stream_event" && ev.event?.type === "content_block_delta") {
      const delta: string = ev.event.delta?.text ?? "";
      if (!delta) return;
      if (!t.firstToken) t.firstToken = Date.now() - t.started;
      t.text += delta;
      if (!t.cueDone) {
        const nl = t.text.indexOf("\n");
        if (nl < 0) t.handlers.onCueDelta?.(delta, t.text);
        else {
          // The newline closes the cue; anything past it belongs to the points.
          const tail = delta.slice(0, delta.length - (t.text.length - nl));
          if (tail) t.handlers.onCueDelta?.(tail, t.text.slice(0, nl));
          t.cueDone = true;
          t.handlers.onCueDone?.(t.text.slice(0, nl).trim());
        }
      }
      return;
    }
    if (ev.type === "result" || typeof ev.duration_api_ms === "number") {
      clearTimeout(t.timer);
      this.recordUsage(ev);
      this.turn = null; this.turns++;
      if (!t.cueDone) t.handlers.onCueDone?.(t.text.split("\n")[0].trim());
      t.resolve({ ...parseAnswer(t.text), model: MODEL.quick, firstTokenMs: t.firstToken, totalMs: Date.now() - t.started });
    }
  }

  async ask(input: { turns: Turn[]; mode: Mode; effort: Effort; imagePath?: string }, handlers: StreamHandlers = {}): Promise<Answer> {
    if (input.effort === "deep") return this.askOneShot(input, handlers);
    if (this.turn) throw new Error("a turn is already in flight");
    if (!this.proc) this.proc = this.spawnProc();
    const proc = this.proc;
    const payload = { type: "user", message: { role: "user", content: [{ type: "text", text: this.userMessage(input) }] } };
    return new Promise<Answer>((resolve, reject) => {
      this.turn = {
        resolve, reject, handlers, started: Date.now(), firstToken: 0, text: "", cueDone: false,
        timer: setTimeout(() => { this.lastError = "timed out"; this.kill(); }, TIMEOUT_MS.quick),
      };
      try { proc.stdin!.write(JSON.stringify(payload) + "\n"); }
      catch (e) { this.failTurn((e as Error).message); }
    });
  }

  /** Deep runs a different model, and a process's model is fixed at spawn — so this one is a
   *  one-shot. It costs the boot time, which matters far less when you chose to wait for Opus. */
  private async askOneShot(input: { turns: Turn[]; mode: Mode; effort: Effort; imagePath?: string }, handlers: StreamHandlers): Promise<Answer> {
    const env = { ...process.env } as Record<string, string | undefined>;
    delete env.CLAUDECODE; delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN; delete env.ANTHROPIC_BASE_URL;
    const started = Date.now();
    let text = "", firstToken = 0, cueDone = false, buf = "";
    return new Promise<Answer>((resolve, reject) => {
      const proc = spawn(resolveClaudeBin(), [
        "--print", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
        "--model", MODEL.deep, "--effort", "high", "--setting-sources", "",
        "--exclude-dynamic-system-prompt-sections", "--allowedTools", "Read",
        "--system-prompt", this.systemPrompt(),
      ], { env, stdio: ["pipe", "pipe", "ignore"] });
      const timer = setTimeout(() => { proc.kill("SIGTERM"); reject(new Error("timed out (deep)")); }, TIMEOUT_MS.deep);
      proc.stdout!.setEncoding("utf8");
      proc.stdout!.on("data", (d: string) => {
        buf += d; let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let ev: any; try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === "result" || typeof ev.duration_api_ms === "number") this.recordUsage(ev);
          if (ev.type === "stream_event" && ev.event?.type === "content_block_delta") {
            const delta = ev.event.delta?.text ?? ""; if (!delta) continue;
            if (!firstToken) firstToken = Date.now() - started;
            text += delta;
            if (!cueDone) {
              const i = text.indexOf("\n");
              if (i < 0) handlers.onCueDelta?.(delta, text);
              else { cueDone = true; handlers.onCueDone?.(text.slice(0, i).trim()); }
            }
          }
        }
      });
      proc.on("close", () => {
        clearTimeout(timer);
        if (!cueDone) handlers.onCueDone?.(text.split("\n")[0].trim());
        if (!text.trim()) return reject(new Error("empty response"));
        resolve({ ...parseAnswer(text), model: MODEL.deep, firstTokenMs: firstToken, totalMs: Date.now() - started });
      });
      proc.on("error", (e) => { clearTimeout(timer); reject(e); });
      proc.stdin!.write(this.userMessage(input)); proc.stdin!.end();
    });
  }

  private userMessage(input: { turns: Turn[]; mode: Mode; imagePath?: string }): string {
    const lines = input.turns.map((t) => `[${new Date(t.t).toLocaleTimeString("en-GB")}] ${t.ch.toUpperCase()}: ${t.text}`).join("\n");
    const lastThem = [...input.turns].reverse().find((t) => t.ch === "them")?.text ?? "";
    const lang = !lastThem ? "the interviewer's language"
      : /[áéíóúñ¿¡]|\b(el|la|los|las|que|qué|de|en|con|para|una|es|un|y|cómo|cuál|puedes|cuéntame)\b/i.test(lastThem) ? "Spanish" : "English";
    return [
      input.imagePath ? `Read this screenshot first: @${input.imagePath}` : "",
      input.mode === "solve"
        ? "MODE: SOLVE. Your task is ONLY what the attached screenshot shows. Read it with the Read tool before writing anything. Ignore the transcript below except as background — do not comment on it, do not remark that a sentence was cut off. Line 1 is the spoken cue naming your approach, then the bullets, then a fenced code block with the complete solution. If the screenshot has no solvable task, say exactly that on line 1."
        : "MODE: ANSWER. Give the cue for the latest interviewer turn.",
      `REPLY LANGUAGE: ${lang} (the language of the latest THEM turn; ignore the dossier's language).`,
      lines ? `New transcript since your last reply:\n${lines}` : "(no new transcript)",
    ].filter(Boolean).join("\n\n");
  }
}

/** Line 1 is the cue; "- " lines are points; a fenced block is the code. */
export function parseAnswer(text: string): Pick<Answer, "cue" | "points" | "code"> {
  const fence = text.match(/```(\w+)?\n([\s\S]*?)(?:```|$)/);
  const code = fence && fence[2].trim() ? { lang: fence[1] || "text", body: fence[2].replace(/\s+$/, "") } : null;
  const body = fence ? text.slice(0, fence.index) : text;
  const lines = body.split("\n");
  let cue = (lines.shift() ?? "").trim().replace(/^["'`]|["'`]$/g, "");
  if (/^\(?nada\)?\.?$/i.test(cue) || /^\(nothing\)$/i.test(cue)) cue = "";
  const points = lines.map((l) => l.trim()).filter((l) => /^[-•*]\s+/.test(l)).map((l) => l.replace(/^[-•*]\s+/, "")).slice(0, 6);
  return { cue, points, code };
}

// CLI: bun brain.ts --test "<question>" [--deep] [--image <jpg>]
if (import.meta.main) {
  const a = process.argv.slice(2);
  const q = a[a.indexOf("--test") + 1];
  if (a.indexOf("--test") < 0 || !q) { console.error('usage: bun brain.ts --test "<question>" [--deep] [--image <jpg>]'); process.exit(1); }
  const img = a.indexOf("--image") >= 0 ? a[a.indexOf("--image") + 1] : undefined;
  const dir = join(homedir(), ".claude/LIFEOS/USER/INTERVIEW_AI");
  const brain = new Brain({ dossierPath: join(dir, "dossier.md"), jdPath: join(dir, "jd.md") });
  const deep = a.includes("--deep");
  if (!deep) { brain.warm(); await Bun.sleep(2500); }   // mirror the server: process warm before the turn
  const res = await brain.ask(
    { turns: [{ t: Date.now(), ch: "them", text: q }], mode: img ? "solve" : "answer", effort: deep ? "deep" : "quick", imagePath: img },
    { onCueDone: (c) => console.error(`[cue @ first-token] ${c}`) },
  );
  console.log(JSON.stringify(res, null, 2));
  brain.kill();
  process.exit(0);
}
