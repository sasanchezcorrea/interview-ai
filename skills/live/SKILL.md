---
name: live
description: Start Interview AI, the live interview / meeting copilot. Boots the local sidecar (whisper.cpp transcription + Claude brain on your subscription) and opens the panel that shows the live transcript, the suggested answer to say next, talking points, and code with a Copy button. USE WHEN the user says "interview ai", "interview-ai", "arranca interview ai", "entrevista en vivo", "live interview", "meeting copilot", "copiloto de reunión", "tengo una entrevista ahora", "start the interview copilot". NOT FOR the TELOS context interview (/interview) or interview practice/mock questions.
---

<!-- The product ships in English; the Spanish trigger phrases stay bilingual on purpose,
     because the principal talks to Claude in Spanish. -->

# /interview-ai:live — start the live copilot

Interview AI listens to a call running in a Chrome tab (Google Meet, Teams web, Zoom web), reads what is on the shared screen, and suggests what the candidate should say next, spoken into their headphones and shown in a panel. Everything it produces goes only to the candidate's own panel; the candidate speaks and types themselves. It never writes into other apps and has no hiding features. Use it only where AI assistance is allowed or declared.

## Steps

1. **Dependencies.** Run `bash ${CLAUDE_PLUGIN_ROOT}/server/setup.sh`. It installs `whisper-cpp` via Homebrew, downloads `ggml-small.bin` (~470 MB) and creates the working dirs. Idempotent; skip if it already printed OK before.
2. **Dossier check.** If `~/.claude/LIFEOS/USER/INTERVIEW_AI/dossier.md` does not exist, tell the user the brain will answer from general best practice and offer `/interview-ai:prep <job description>` to personalize it (it takes ~1 minute). Do not block on it.
3. **Start the sidecar**: `bash ${CLAUDE_PLUGIN_ROOT}/server/start.sh`. It launches the server in its own session (a plain `nohup … &` does NOT survive the shell or agent tool-call that started it), waits until `/health` reports `"whisper":true`, and prints the URL. It is idempotent: if the server is already up it says so and exits 0. Cold start compiles Metal shaders once (~30-60 s); warm start is ~1 s. If it prints a WARN, read `/tmp/interview-ai/server.log`.
4. **Open the panel**: `open http://127.0.0.1:31338` (Chrome). If the user wants to rehearse first, also mention `http://127.0.0.1:31338/mock`, a fake interviewer that speaks questions and shows a coding task.
5. **Pre-flight checklist** (say it once, short):
   - Headphones on, so the spoken cue never reaches the call microphone.
   - Pick a source: *Tab* for a browser call (Meet, Teams web, Zoom web) or *Screen + system* for desktop Zoom/Teams. **Chrome's picker has an audio checkbox and it must be ticked** — sharing a surface without it gives video and no transcript, which is the single most common failure. Then *Mic* so their own answers become context.
   - *Auto* answers every interviewer question; *Answer now* (⌥↵) forces one; *Solve what's on screen* (⌥S) attaches the current screen and asks for a full solution; *Deep* switches the brain to Opus for hard problems; *Float* pops the answer card into an always-on-top window.
   - Paste the job description under *Context* if `/interview-ai:prep` was not run.
6. **Stop**: `bash ${CLAUDE_PLUGIN_ROOT}/server/stop.sh` (stops the sidecar and the whisper-server it started). Screenshots live in `/tmp/interview-ai/` and are pruned to the last 40.

## Troubleshooting

- `whisper:false` after 60 s → `tail -40 /tmp/interview-ai/server.log`; usually the model path (`IAI_WHISPER_MODEL`) or a port clash on 8178 (`IAI_WHISPER_PORT`).
- Transcript empty while the interviewer talks → look at the channel strips. `no source` means no source; `no frames` means the audio graph never started; `silent` means a surface was shared without its audio checkbox — re-pick and tick it. A **window** share never carries audio; a tab or a whole screen does.
- Brain errors → `claude --version` must work on PATH and the subscription login must be valid (`claude -p "ping" --output-format json`).
- Latency: end of question → cue measured at 7.5-10 s (silence 0.8 s + whisper ~0.3 s + Claude 6-9 s). The transcript shows in ~1 s.
