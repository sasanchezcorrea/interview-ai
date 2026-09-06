# Interview AI (`interview-ai`)

Live interview / meeting copilot for Claude Code. It listens to a call running in a Chrome tab, reads the shared screen, and suggests the best thing to say next, in your headphones and on your own panel, using your Claude subscription and your LifeOS context.

**What it does not do, by design:** it never types into other apps or the shared screen (code shows up with a *Copy* button), and it has no hiding features. The panel is an ordinary Chrome window. Use it where AI assistance is allowed or declared.

## Install

Inside Claude Code, in an interactive terminal:

```bash
/plugin marketplace add sasanchezcorrea/interview-ai
/plugin install interview-ai@interview-ai
```

Then `/interview-ai` starts it. `/plugin` is a terminal command — it is not available in the
desktop app.

## Quick start, from a clone

```bash
bash server/setup.sh          # whisper.cpp + ffmpeg + ggml-medium model + capture helper (once)
bash server/start.sh          # sidecar on http://127.0.0.1:31338, detached, waits for whisper
open http://127.0.0.1:31338   # the panel
bash server/stop.sh           # stop sidecar + whisper-server
```

`start.sh` launches the server in its own session on purpose: `nohup bun server.ts &` does not survive the shell (or agent tool-call) that started it, which silently kills the sidecar mid-interview.

Or, inside Claude Code: `/interview-ai:prep <job description>` then `/interview-ai:live`.

On macOS press **System** in the panel: native capture takes system audio, the microphone and
the screen at once, with no picker and no share-audio checkbox. The browser buttons are
fallbacks.

1. Put your headphones on.
2. Run the call in a Chrome tab (Meet, Teams web, Zoom web). In the panel press **Tab**, pick that tab, tick **Also share tab audio**. Press **Micro** so your own answers become context.
3. Every interviewer question triggers a cue (≤25 words), talking points and, when a coding task is visible, a full solution. **Responder ahora** (⌥↵) forces one, **Resolver lo que se ve** (⌥S) attaches the screen, **Deep** switches to Opus, **Flotar** pops the answer card into an always-on-top window.

Rehearse without a real call at `http://127.0.0.1:31338/mock`: a fake interviewer that speaks five questions (English and Spanish) and shows a coding exercise.

## How it works

```
Chrome tab (call) ─audio+video─┐
Mic ───────────────────────────┤  panel.html: PCM16 @16k over WS, JPEG of the screen every 4 s when it changes
                               ▼
server.ts (:31338) ── segments on 0.8 s silence ──► whisper-server (:8178, local, on-device)
        │ transcript (them / me)                       ▲ started by server.ts if not running
        ├── question detected or button ──► brain.ts: claude -p --resume <session> --model sonnet|opus
        │                                    system = copilot rules + dossier.md + jd.md
        └── {cue, points, code} ──► panel: card + speechSynthesis (or Pulse/ElevenLabs) + Copy
```

- `server/audio.ts` — silence segmenter, WAV encoder, question detector, whisper-hallucination filter (unit tested: `bun test server/`).
- `server/brain.ts` — `claude -p` wrapper following LifeOS `Inference.ts` (API-key env scrubbed so billing stays on the subscription; `--session-id`/`--resume` keeps one conversation per interview). `bun server/brain.ts --test "question"` for a standalone check.
- `server/server.ts` — HTTP + WebSocket sidecar; `GET /health`, `POST /answer-now`, `POST /context`, `POST /reset`, `POST /tts`.
- `server/native.ts` — runs `helper/iai-capture` and feeds its frames into the same segmenters,
  meters and shot store the browser path uses, so nothing downstream knows which door the audio
  came through. Endpoints: `GET /native/status`, `GET /native/sources`, `POST /native/start|stop`.
  Build the helper once with `cd helper && swift build -c release`; macOS will ask for Screen
  Recording and Microphone the first time.
- `skills/live`, `skills/prep` — the two plugin commands.

## Tests

```bash
bun test server/            # unit: segmenter, WAV encoder, question detector, answer parser
bun server/local-e2e.ts     # integration: the whole pipeline, no browser, ~2 min, 15 rows
bun server/e2e.ts           # optional: the browser leg via real Chrome + CDP (flaky, see below)
```

`local-e2e.ts` is the one that runs every time. It streams real speech through the panel's OWN PCM
encoder — lifted out of `panel.html` at runtime, not retyped — into the real `/audio` socket, then
asserts against the server's `/events` stream: transcription, the trigger firing on a question,
token streaming rebuilding the cue exactly, the latency budget, the candidate's channel, solve mode
reading a screenshot, and the adversarial cases (five seconds of silence and four of pink noise must
produce zero turns and zero model calls; solve with no screenshot must return 409).

`e2e.ts` drives real Chrome to cover what only a browser can: `getDisplayMedia`, the capture button
states, Picture-in-Picture. It is kept but not part of the routine loop — Chrome's
`--auto-select-tab-capture-source-by-title` hands the panel its own tab regardless of the title
asked for, so screenshot-dependent rows there test the harness more than the product.

Env: `IAI_PORT` (31338), `IAI_WHISPER_PORT` (8178), `IAI_WHISPER_MODEL` (`~/.cache/whisper/ggml-medium.bin`), `IAI_WHISPER_PROMPT` (domain vocabulary hint), `IAI_USER_DIR` (`~/.interview-ai`), `IAI_MIN_PEAK` (0.02), `IAI_ECHO_THRESHOLD` (0.45), `IAI_HELPER_BIN`, `IAI_PULSE_URL`.

## Two gates keep the interviewer channel honest

Whisper writes confident sentences from room tone, and with speakers on, the copilot's own spoken
cue comes back in on the interviewer channel — the one that triggers answers. Left alone the thing
answers itself. Two gates, both tuned on measurements from this machine:

- **Loudness.** A segment whose loudest frame is under `0.02` never reaches whisper at all. Real
  speech peaks around `0.085` here; an empty room sits at `0.001-0.004`. Override with
  `IAI_MIN_PEAK`.
- **Fuzzy echo.** Every cue we speak and every turn on the other channel is remembered for 25s. A
  new turn scoring above `0.45` against one of them — the higher of word overlap and character
  trigram similarity — is dropped. Trigrams are what catch our own line coming back garbled, which
  is how it usually returns. Override with `IAI_ECHO_THRESHOLD`.

The guard is asymmetric on purpose: system audio is the clean source of the interviewer's voice and
the microphone is where it arrives second-hand, so the interviewer channel is only ever checked
against cues we spoke, never against the mic. Checking both ways killed the real question whenever
its echo landed first.

Headphones still help, and remove the problem entirely.

## Known limits (v1)

- **Two capture paths, and you must tick the audio box in either.** *Tab* asks Chrome for a browser surface (Meet, Teams web, Zoom web) — tick "Also share tab audio". *Screen + system* asks for a monitor with system audio (Chrome 141+ on macOS 14.2+, so desktop Zoom and Teams work too) — tick "Also share system audio". Share a surface without its audio and you get video with no transcript; the panel now refuses to show a green light in that case and tells you exactly what to re-pick.
- A window share never carries audio. Pick a tab or a whole screen.
- End of question → first spoken word measured at ~2.5 s p50 with Sonnet (silence 0.45 s + whisper ~0.6 s + first token ~1.1 s), more when a screenshot is attached or *Deep* switches to Opus. The cue is spoken clause by clause as it streams, so speaking starts before the line finishes.
- Whisper `small` mishears rare proper nouns; `IAI_WHISPER_SIZE=medium server/setup.sh` and `IAI_WHISPER_MODEL=~/.cache/whisper/ggml-medium.bin` trade speed for accuracy.
- Several interviewers share one channel (no diarization).
