---
name: live
description: Start Interview AI, the live interview / meeting copilot. Boots the local sidecar (whisper.cpp transcription + Claude brain on your subscription) and opens the panel that shows the live transcript, the suggested answer to say next, talking points, and code with a Copy button. USE WHEN the user says "interview ai", "interview-ai", "arranca interview ai", "entrevista en vivo", "live interview", "meeting copilot", "copiloto de reunión", "tengo una entrevista ahora", "start the interview copilot". NOT FOR the TELOS context interview (/interview) or interview practice/mock questions.
---

<!-- The product ships in English; the Spanish trigger phrases stay bilingual on purpose. -->

# /interview-ai:live — start the live copilot

Interview AI listens to a call, reads what is on the shared screen, and suggests what the
candidate should say next — in their own panel and their own headphones. Everything it produces
goes only to that panel; the candidate speaks and types themselves. It never writes into other
apps and has no hiding features. Use it only where AI assistance is allowed or declared.

## Resolving the plugin root

Every path below is written against `$ROOT`. Resolve it FIRST, in one line, because the plugin
runs both as an installed marketplace plugin and straight out of a skills directory, and only
the first of those defines `CLAUDE_PLUGIN_ROOT`:

```bash
ROOT="${CLAUDE_PLUGIN_ROOT:-<this skill's base directory>/../..}"
```

Claude Code prints "Base directory for this skill" when it loads this file — that is the value to
substitute. Confirm with `ls "$ROOT/server/start.sh"` before running anything.

## Steps

1. **Dependencies.** Run `bash $ROOT/server/setup.sh`. It installs `whisper-cpp`
   and `ffmpeg` via Homebrew, downloads the model, and fetches the native capture helper
   (verifying its checksum). Idempotent — skip it if it has printed OK before.
2. **Context check.** The brain answers from a dossier and a job context. If `"jd"` in
   `/health` is empty, tell the user to press **Context** in the panel and paste the posting or
   what the meeting is about; without it the answers are generic. `/interview-ai:prep` builds a
   fuller dossier. Do not block on either.
3. **Start the sidecar**: `bash $ROOT/server/start.sh`. It runs the server in
   its own session — a plain `nohup … &` does not survive the shell or tool-call that started
   it — and waits until `/health` reports `"whisper":true`. Idempotent. Cold start compiles
   Metal shaders once (~30-60 s); warm start is ~1 s. On a WARN, read `/tmp/interview-ai/server.log`.
4. **Open the panel**: `open http://127.0.0.1:31338`. Never claim it is ready before the health
   check passes.
5. **Pre-flight**, said once and short:
   - Headphones, so the spoken cue never reaches the call microphone. Without them the copilot
     hears itself; two gates catch most of that, but headphones remove the problem.
   - Press **System**. That is the whole setup: native macOS capture takes system audio, the
     microphone and the screen at once, with no picker and no share-audio checkbox. macOS asks
     for Screen Recording and Microphone the first time — grant them and press it again.
     *Tab* and *Screen + system* are browser fallbacks for when the native helper is unavailable.
   - *Auto* answers every interviewer question; *Answer now* (⌥↵) forces one; *Solve what's on
     screen* (⌥S) attaches the current frame and asks for a full solution; *Deep* switches the
     brain from Sonnet to Opus for hard problems, at roughly double the latency; *Float* pops
     the answer card into an always-on-top window.
   - The header carries the honest instruments: transcription time, model, first token,
     question→voice, and tokens spent this session.
6. **Stop**: `bash $ROOT/server/stop.sh` stops the sidecar and the whisper
   server, and with them any capture. To pause capture but keep the session, press **System**
   again. Screenshots live in `/tmp/interview-ai/`, pruned to the last 40.

## Troubleshooting

- `whisper:false` after 60 s → `tail -40 /tmp/interview-ai/server.log`; usually the model path
  (`IAI_WHISPER_MODEL`) or a port clash on 8178 (`IAI_WHISPER_PORT`).
- Nothing in the transcript → read the channel strips, not the buttons. `no source` means no
  source is armed; `no frames` means the audio graph never started; a strip that is live with a
  meter pinned at the floor means the source carries no sound. With a browser source that is
  almost always the unticked audio checkbox; a **window** share never carries audio at all.
- Turns appearing that nobody said → those are gated already: segments below `IAI_MIN_PEAK`
  (0.02) never reach whisper, and anything matching a spoken cue or the other channel within
  25 s is discarded as echo. The log names which gate fired and why.
- Brain errors → `claude --version` must work on PATH and the subscription login must be valid
  (`claude -p "ping" --output-format json`).
- Latency: end of question to first spoken word runs ~2.5 s at p50 (silence 0.45 s + whisper
  ~0.6 s + first token ~1.1 s). The transcript itself lands in about a second.
