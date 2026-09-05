# iai-capture

Native macOS replacement for the Chrome `getDisplayMedia()` picker: captures the
screen, system audio, and microphone directly via ScreenCaptureKit +
AVFoundation. No browser tab, no picker, no easily-missed "share audio"
checkbox — and it can see the frontmost app/window, which a shared browser
tab never could.

One `SCStream` delivers all three: system audio and microphone arrive as two
separate tapped outputs on the same stream (`SCStreamOutputType.audio` /
`.microphone`, macOS 15+), and screenshots come off `SCStreamOutputType.screen`
at a low, configurable frame rate.

## Build

Command Line Tools only — no Xcode required:

```bash
cd helper
swift build -c release
```

Binary lands at `.build/release/iai-capture`. Verified on this machine
(macOS 26.6.2, M3 Max, Swift 6.3.3, CLT only, no Xcode.app): clean build
completes in ~40s with zero warnings.

## Run

```bash
.build/release/iai-capture [options]

  --fps <n>       Screenshot rate, frames per second (default: 1)
  --no-mic        Do not capture the microphone
  --no-audio      Do not capture system audio
  --no-screen     Do not capture screenshots
  --display <i>   Capture display index <i> from --list (default: 0)
  --list          Print displays and running applications as JSON, then exit
  --help          Show usage
```

Everything below is real output captured on this machine while writing this.

`--list` (1 display, 3 running apps at the time):

```json
{"applications":[{"bundleId":"com.apple.dock","name":"Dock","pid":748},{"bundleId":"","name":"","pid":442},{"bundleId":"com.westbridge.stremio5-mac","name":"Stremio","pid":13560}],"displays":[{"displayID":1,"height":1329,"index":0,"width":2056}]}
```

A 5s run with `--no-screen` while `say "..."` spoke through the speakers:

```
=== frame counts ===
  kind 0 (system_audio): 260 frames, 166388 bytes
  kind 1 (microphone): 475 frames, 162122 bytes
  kind 3 (status): 2 frames, 188 bytes
=== audio RMS (mean per-frame RMS, int16 scale 0-32767) ===
  system_audio: mean RMS = 3045.39 over 260 frames
  microphone: mean RMS = 203.73 over 475 frames
```

System audio picked up the spoken text directly (high RMS); the microphone
picked up ambient/speaker bleed in the room (lower but clearly non-zero —
proof the mic tap is live, not silently dropped). A separate 3s run with
`--no-audio --no-mic --fps 2` produced 6 real JPEG screenshots at the
display's native 2056x1329 resolution (verified with `sips`/`file`).

## Wire protocol (the contract with the Bun sidecar)

**stdout**: a stream of length-prefixed binary frames. Header is 6 bytes:

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | magic — always `0x49` (`'I'`) |
| 1 | 1 | kind |
| 2 | 4 | payload length, uint32 **little-endian** |
| 6 | *length* | payload |

| kind | Meaning | Payload |
|---|---|---|
| 0 | System audio | PCM, **Int16 little-endian, 16000 Hz, mono** |
| 1 | Microphone | PCM, **Int16 little-endian, 16000 Hz, mono** |
| 2 | Screenshot | JPEG bytes |
| 3 | Status | UTF-8 JSON: `{"app","bundleId","title","t"}` — emitted on every frontmost-app change and at least every 5s |

**stderr**: human-readable log lines only. Never mixed into stdout — the
sidecar can read stdout as a pure binary stream without a line-based parser
getting confused by a stray log line.

A tiny verification script for this protocol lives at
`scripts/frame_stats.py` (stdlib-only): pipe a raw capture through it and it
reports frame counts per kind and audio RMS.

```bash
.build/release/iai-capture --no-screen > /tmp/cap.raw &
PID=$!; sleep 5; kill -INT $PID; wait
python3 scripts/frame_stats.py /tmp/cap.raw
```

## Permissions (TCC)

Two hard-gated permissions, both required for full capture:

- **Screen Recording** — gates `SCShareableContent`/`SCStream` entirely (covers
  screen *and* system audio, since both come through ScreenCaptureKit).
  System Settings → Privacy & Security → Screen Recording.
- **Microphone** — gates `captureMicrophone`. This tool calls
  `AVCaptureDevice.requestAccess(for: .audio)` before touching `SCStream`,
  since that's the reliable way to trigger the system prompt for a bare CLI
  binary. System Settings → Privacy & Security → Microphone.

On denial or refusal, `iai-capture` prints which pane to open on **stderr**
and exits with **code 13** — distinct from a generic crash (exit 1), so the
Bun sidecar can tell "go click something" apart from "the code is broken".
It never hangs silently: `SCShareableContent`/`startCapture` failures and a
`.notDetermined`/`.denied` mic status are all handled explicitly before the
stream is ever started.

A third permission, **Accessibility**, is soft — it only gates the focused
*window title* in the kind-3 status JSON (via `AXUIElementCopyAttributeValue`).
Without it, `title` comes back as `""`; nothing fails or blocks on it, since
it's not part of the required capture path.

## Known constraint: no Xcode, no signed `.app`

This machine has Command Line Tools only (`xcode-select -p` →
`/Library/Developer/CommandLineTools`) — no `xcodebuild`, no `.app` bundle
target. `iai-capture` is therefore a **plain, unsigned Mach-O binary**, not a
proper `.app` with an `Info.plist` and a bundle identifier. Two consequences:

1. **TCC attribution**: since the binary has no bundle identity, macOS
   attributes Screen Recording / Microphone / Accessibility grants to the
   **parent terminal process** (Terminal.app, iTerm, etc.) that launches it,
   not to `iai-capture` itself. Grant the permission to your terminal app, not
   to a nonexistent "iai-capture.app" entry.
2. No entitlements, no code signature, no notarization. Fine for a local dev
   tool invoked by the Bun sidecar; would need an actual `.app` + Xcode (or
   at minimum `codesign` with a Developer ID) before distributing this to
   another machine.

## Implementation notes (for the next reader)

- **Concurrency**: `swift-tools-version:5.10` — Swift 5 language mode, not
  Swift 6 strict concurrency. `SCStreamOutput` callbacks land on background
  queues; `FrameWriter` serializes stdout writes onto one queue and uses a
  bounded `DispatchSemaphore` (32 slots) to drop frames under backpressure
  rather than block a capture callback — a dropped frame beats a stalled
  pipeline.
- **No async/await**: every ScreenCaptureKit call that could be async is
  driven through its completion-handler form, bridged to synchronous via a
  `DispatchSemaphore`. `SCShareableContent.getShareableContent(completionHandler:)`
  doesn't actually exist in Swift — it's fully claimed by
  `NS_SWIFT_ASYNC_NAME(getter:current())` in the header — so `--list` and the
  display lookup use `SCShareableContent.getExcludingDesktopWindows(_:onScreenWindowsOnly:completionHandler:)`
  instead.
- **Audio resampling**: `AudioResampler` converts whatever ScreenCaptureKit
  hands us (system audio: fixed by `SCStreamConfiguration.sampleRate`/
  `channelCount`; mic: the device's native format) to Int16/16kHz/mono via
  `AVAudioConverter`. The `CMSampleBuffer` → `AVAudioPCMBuffer` bridge follows
  Apple's documented two-pass `CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer`
  pattern (size query, then fill); the retained `CMBlockBuffer` is kept alive
  by capturing it in the PCM buffer's own deallocator closure, so its lifetime
  matches the no-copy buffer's exactly.
- **Screen frames**: only `SCFrameStatus.complete` samples get JPEG-encoded
  (idle/blank/suspended frames arrive on schedule too but carry no new
  pixels). `minimumFrameInterval` does the fps throttling — no manual frame
  skipping.
- **Shutdown**: `SIGINT`/`SIGTERM` are ignored at the signal level and handled
  via `DispatchSource` signal sources on the main queue (a real signal handler
  can't safely call `stream.stopCapture` or `exit`), so `RunLoop.main.run()`
  keeps the process alive between GCD-delivered events.
