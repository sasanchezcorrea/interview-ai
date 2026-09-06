---
description: Stop the Interview AI copilot and its capture
---

Stop Interview AI completely: run `${CLAUDE_PLUGIN_ROOT}/server/stop.sh`, which kills the
sidecar and the whisper server, and with them any capture still running.

Confirm it is really down (`curl -s -m 2 http://127.0.0.1:31338/health` should fail to
connect), then say plainly that nothing is recording any more. If the user only wants to pause
capture but keep the session and transcript, tell them to press **System** in the panel
instead — that stops the microphone and screen without tearing down the server.
