---
description: Start the Interview AI copilot and open its panel in the browser
---

Start the Interview AI sidecar and open the candidate panel. Do it in this order and report
only what actually happened — never claim the panel is ready without the health check passing.

1. Run `${CLAUDE_PLUGIN_ROOT}/server/start.sh`. It is idempotent: if the sidecar is already
   running it says so and exits 0. First start loads the whisper model and can take ~90s.
2. If it fails because a dependency is missing (bun, whisper-server, ffmpeg, the model file,
   the native helper), run `${CLAUDE_PLUGIN_ROOT}/server/setup.sh` once, then retry step 1.
   Setup also fetches the signed capture helper and checks its checksum. Do not try to work
   around a missing dependency.
3. Confirm with `curl -s http://127.0.0.1:31338/health` that `"whisper":true` before saying it
   is ready.
4. Open the panel: `open http://127.0.0.1:31338/`.

Then tell the user, in three short lines:
- The panel is open, and the one button they need is **System** — it turns capture on and off
  (system audio, microphone and screen) with no picker and no share-audio checkbox.
- Whether a job context is set. If `"jd"` in the health response is empty, tell them to press
  **Context** in the panel and paste the job posting or what the meeting is about, because
  without it the answers are generic.
- That nothing is being recorded until they press System.

This is a declared copilot: it only ever writes to the candidate's own panel. If the user asks
to have it type into the shared screen, or to hide it from screen-sharing or proctoring
software, say no and explain that the tool does not do that.
