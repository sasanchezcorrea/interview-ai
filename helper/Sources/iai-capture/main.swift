// iai-capture — native macOS capture helper for Interview AI.
//
// Replaces the Chrome getDisplayMedia() picker (whose "share audio" checkbox
// is easy to miss, and which can't see desktop Zoom/Teams or which app is
// focused) with a direct ScreenCaptureKit + AVFoundation capture. One SCStream
// delivers system audio, microphone audio, and periodic screenshots as three
// separate tapped outputs. Wire protocol -> stdout, logs -> stderr, see
// README.md for the full contract.
//
// No third-party dependencies; CLI parsing is hand-rolled (see Ponytail rung 3/5).

import AppKit
import ApplicationServices
import AVFoundation
import CoreImage
import CoreMedia
import Dispatch
import Foundation
import ScreenCaptureKit

// MARK: - Wire protocol (stdout)

private let magicByte: UInt8 = 0x49 // 'I'

/// 6-byte header: ['I', kind, uint32-LE payload length], then the payload.
private func frameHeader(kind: UInt8, length: Int) -> Data {
    var header = Data(capacity: 6)
    header.append(magicByte)
    header.append(kind)
    var len = UInt32(length).littleEndian
    withUnsafeBytes(of: &len) { header.append(contentsOf: $0) }
    return header
}

/// Serializes stdout writes off whatever thread produced the frame (SCStream
/// callbacks arrive on background queues) and drops frames under
/// backpressure instead of blocking a capture callback — a dropped frame is
/// far better than a stalled capture pipeline.
final class FrameWriter {
    static let shared = FrameWriter()

    private let queue = DispatchQueue(label: "iai.stdout")
    private let slots: DispatchSemaphore
    private let handle = FileHandle.standardOutput

    init(maxPending: Int = 32) {
        slots = DispatchSemaphore(value: maxPending)
    }

    func write(kind: UInt8, payload: Data) {
        guard slots.wait(timeout: .now()) == .success else {
            logErr("dropped frame kind=\(kind) (\(payload.count) bytes, writer backpressure)")
            return
        }
        queue.async { [handle, slots] in
            var frame = frameHeader(kind: kind, length: payload.count)
            frame.append(payload)
            handle.write(frame)
            slots.signal()
        }
    }
}

// MARK: - Logging / exit helpers

private func logErr(_ message: String) {
    FileHandle.standardError.write("iai-capture: \(message)\n".data(using: .utf8)!)
}

/// Generic, non-permission failure.
private func fail(_ message: String) -> Never {
    logErr(message)
    exit(1)
}

/// TCC/permission failure — distinct exit code so the Bun sidecar can tell
/// "user needs to click something" apart from "the code is broken".
private func failPermission(_ message: String) -> Never {
    logErr(message)
    exit(13)
}

private let screenRecordingHelp =
    "Screen Recording permission is required. Open System Settings > Privacy & Security > Screen Recording, " +
    "enable it for this terminal app, then re-run. (Without Xcode this binary has no bundle identity, so macOS " +
    "attributes the request to the parent terminal — see README.md.)"

private let microphoneHelp =
    "Microphone permission is required. Open System Settings > Privacy & Security > Microphone, " +
    "enable it for this terminal app, then re-run."

/// Screen Recording / stream-start failures surface as NSError in the
/// SCStreamErrorDomain; -3801 is SCStreamErrorUserDeclined, -3820 is
/// SCStreamErrorFailedToStartMicrophoneCapture (see SCError.h).
private func classifyAndFail(_ error: Error, context: String) -> Never {
    let nsErr = error as NSError
    if nsErr.domain.contains("ScreenCaptureKit") {
        if nsErr.code == -3801 { failPermission(screenRecordingHelp) }
        if nsErr.code == -3820 { failPermission(microphoneHelp) }
    }
    fail("\(context): \(nsErr.localizedDescription) (domain=\(nsErr.domain) code=\(nsErr.code))")
}

// MARK: - CLI

struct Options {
    var fps = 1
    var noMic = false
    var noAudio = false
    var noScreen = false
    var displayIndex: Int?
    var list = false
}

private func printHelp() {
    print("""
    iai-capture — native screen + system audio + microphone capture for Interview AI

    Usage: iai-capture [options]

      --fps <n>       Screenshot rate, frames per second (default: 1)
      --no-mic        Do not capture the microphone
      --no-audio      Do not capture system audio
      --no-screen     Do not capture screenshots
      --display <i>   Capture display index <i> from --list (default: 0)
      --list          Print displays and running applications as JSON, then exit
      --help          Show this message

    Wire protocol on stdout: 6-byte header ['I', kind, uint32-LE length] + payload.
      kind 0 = system audio (PCM s16le, 16000 Hz, mono)
      kind 1 = microphone   (PCM s16le, 16000 Hz, mono)
      kind 2 = JPEG screenshot
      kind 3 = UTF-8 JSON status: {"app","bundleId","title","t"}
    All logs go to stderr. Exit code 13 means a TCC permission was refused.
    """)
}

private func parseArgs() -> Options {
    var options = Options()
    var args = CommandLine.arguments.dropFirst().makeIterator()
    while let arg = args.next() {
        switch arg {
        case "--fps":
            guard let value = args.next(), let n = Int(value), n > 0 else {
                fail("--fps requires a positive integer")
            }
            options.fps = n
        case "--no-mic":
            options.noMic = true
        case "--no-audio":
            options.noAudio = true
        case "--no-screen":
            options.noScreen = true
        case "--display":
            guard let value = args.next(), let n = Int(value), n >= 0 else {
                fail("--display requires a non-negative integer index")
            }
            options.displayIndex = n
        case "--list":
            options.list = true
        case "--help", "-h":
            printHelp()
            exit(0)
        default:
            fail("unknown argument: \(arg) (try --help)")
        }
    }
    return options
}

// MARK: - ScreenCaptureKit: completion-handler -> synchronous bridges
//
// Everything below uses completion handlers + DispatchSemaphore rather than
// async/await: main.swift's top level isn't an async context, and a blocking
// bridge is simpler than standing up a Task just to sequence four setup calls.

private func getShareableContentSync() -> Result<SCShareableContent, Error> {
    let sem = DispatchSemaphore(value: 0)
    var result: Result<SCShareableContent, Error>!
    // The plain getShareableContent(completionHandler:) is fully claimed by
    // NS_SWIFT_ASYNC_NAME(getter:current()) in the ObjC header, so the only
    // non-async entry point left is this excluding/onScreen-only overload.
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, error in
        if let error {
            result = .failure(error)
        } else if let content {
            result = .success(content)
        } else {
            result = .failure(NSError(domain: "iai-capture", code: -1))
        }
        sem.signal()
    }
    sem.wait()
    return result
}

private func requestMicrophoneAccessSync() -> Bool {
    let sem = DispatchSemaphore(value: 0)
    var granted = false
    AVCaptureDevice.requestAccess(for: .audio) { ok in
        granted = ok
        sem.signal()
    }
    sem.wait()
    return granted
}

private func startCaptureSync(_ stream: SCStream) -> Error? {
    let sem = DispatchSemaphore(value: 0)
    var startError: Error?
    stream.startCapture { error in
        startError = error
        sem.signal()
    }
    sem.wait()
    return startError
}

// MARK: - --list

private func runList() -> Never {
    switch getShareableContentSync() {
    case .failure(let error):
        classifyAndFail(error, context: "failed to enumerate shareable content")
    case .success(let content):
        let displays: [[String: Any]] = content.displays.enumerated().map { index, display in
            ["index": index, "displayID": Int(display.displayID), "width": display.width, "height": display.height]
        }
        let applications: [[String: Any]] = content.applications.map { app in
            ["bundleId": app.bundleIdentifier, "name": app.applicationName, "pid": Int(app.processID)]
        }
        let json: [String: Any] = ["displays": displays, "applications": applications]
        let data = (try? JSONSerialization.data(withJSONObject: json, options: [.sortedKeys])) ?? Data("{}".utf8)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
        exit(0)
    }
}

// MARK: - Audio resampling (CMSampleBuffer -> Int16 16kHz mono)

/// Converts whatever format ScreenCaptureKit hands us (system audio and mic
/// are both typically Float32 @48kHz, but this doesn't assume it) to the wire
/// contract via AVAudioConverter. One instance per audio source: the source
/// format is fixed for the life of a stream, so the converter is built once.
final class AudioResampler {
    private var converter: AVAudioConverter?
    private let targetFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!

    func process(_ sampleBuffer: CMSampleBuffer) -> Data? {
        guard let input = Self.pcmBuffer(from: sampleBuffer) else { return nil }

        if converter == nil {
            converter = AVAudioConverter(from: input.format, to: targetFormat)
        }
        guard let converter else { return nil }

        let ratio = targetFormat.sampleRate / input.format.sampleRate
        let capacity = AVAudioFrameCount(Double(input.frameLength) * ratio) + 32
        guard let output = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return nil }

        var delivered = false
        var convError: NSError?
        let status = converter.convert(to: output, error: &convError) { _, outStatus in
            if delivered {
                outStatus.pointee = .noDataNow
                return nil
            }
            delivered = true
            outStatus.pointee = .haveData
            return input
        }
        guard status != .error, convError == nil, let channel = output.int16ChannelData else { return nil }
        return Data(bytes: channel[0], count: Int(output.frameLength) * MemoryLayout<Int16>.size)
    }

    /// CMSampleBuffer -> AVAudioPCMBuffer with no copy, following Apple's
    /// documented two-pass CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer
    /// pattern (first call sizes the AudioBufferList, second call fills it).
    /// The retained CMBlockBuffer is kept alive via the PCM buffer's own
    /// deallocator closure — it's released exactly when the PCM buffer is.
    private static func pcmBuffer(from sampleBuffer: CMSampleBuffer) -> AVAudioPCMBuffer? {
        guard let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbdPointer = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription) else {
            return nil
        }
        var asbd = asbdPointer.pointee
        guard let format = AVAudioFormat(streamDescription: &asbd) else { return nil }

        var sizeNeeded = 0
        _ = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer, bufferListSizeNeededOut: &sizeNeeded, bufferListOut: nil, bufferListSize: 0,
            blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: nil
        )
        let allocSize = max(sizeNeeded, MemoryLayout<AudioBufferList>.size)
        let rawList = UnsafeMutableRawPointer.allocate(byteCount: allocSize, alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { rawList.deallocate() }
        let audioBufferList = rawList.assumingMemoryBound(to: AudioBufferList.self)

        var blockBuffer: CMBlockBuffer?
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer, bufferListSizeNeededOut: nil, bufferListOut: audioBufferList, bufferListSize: allocSize,
            blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, blockBufferOut: &blockBuffer
        )
        guard status == noErr else { return nil }

        let frameLength = AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: audioBufferList, deallocator: { _ in
            withExtendedLifetime(blockBuffer) {}
        }) else { return nil }
        buffer.frameLength = frameLength
        return buffer
    }
}

// MARK: - Frontmost-app / window-title status (kind 3)

/// Emits a status frame whenever the frontmost app changes, and at least
/// every 5s regardless. Window title is best-effort via the Accessibility
/// API — soft-fails to "" without Accessibility permission (that permission
/// is not part of this tool's TCC contract, unlike Screen Recording/Mic).
final class AppMonitor {
    private var timer: DispatchSourceTimer?

    init() {
        NSWorkspace.shared.notificationCenter.addObserver(
            self, selector: #selector(appChanged),
            name: NSWorkspace.didActivateApplicationNotification, object: nil
        )
        emit()
        let t = DispatchSource.makeTimerSource(queue: .main)
        t.schedule(deadline: .now() + 5, repeating: 5)
        t.setEventHandler { [weak self] in self?.emit() }
        t.resume()
        timer = t
    }

    @objc private func appChanged(_ note: Notification) {
        emit()
    }

    private func emit() {
        let app = NSWorkspace.shared.frontmostApplication
        let json: [String: Any] = [
            "app": app?.localizedName ?? "",
            "bundleId": app?.bundleIdentifier ?? "",
            "title": Self.focusedWindowTitle(pid: app?.processIdentifier),
            "t": Int(Date().timeIntervalSince1970 * 1000),
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: json) else { return }
        FrameWriter.shared.write(kind: 3, payload: data)
    }

    private static func focusedWindowTitle(pid: pid_t?) -> String {
        guard let pid, AXIsProcessTrusted() else { return "" }
        let axApp = AXUIElementCreateApplication(pid)
        var windowRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute as CFString, &windowRef) == .success,
              let window = windowRef else { return "" }
        var titleRef: CFTypeRef?
        let axWindow = window as! AXUIElement
        guard AXUIElementCopyAttributeValue(axWindow, kAXTitleAttribute as CFString, &titleRef) == .success,
              let title = titleRef as? String else { return "" }
        return title
    }
}

// MARK: - Capture delegate: SCStreamOutput + SCStreamDelegate

final class CaptureDelegate: NSObject, SCStreamOutput, SCStreamDelegate {
    private let systemAudio = AudioResampler()
    private let mic = AudioResampler()
    private let ciContext = CIContext()

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard sampleBuffer.isValid else { return }
        switch type {
        case .screen:
            handleScreen(sampleBuffer)
        case .audio:
            if let data = systemAudio.process(sampleBuffer) {
                FrameWriter.shared.write(kind: 0, payload: data)
            }
        case .microphone:
            if let data = mic.process(sampleBuffer) {
                FrameWriter.shared.write(kind: 1, payload: data)
            }
        @unknown default:
            break
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        logErr("stream stopped: \(error.localizedDescription)")
        exit(1)
    }

    private func handleScreen(_ sampleBuffer: CMSampleBuffer) {
        // Only SCFrameStatus.complete carries real pixels — idle/blank/suspended
        // frames still arrive on a schedule and would otherwise re-encode stale data.
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
           let statusRaw = attachments.first?[.status] as? Int,
           SCFrameStatus(rawValue: statusRaw) != .complete {
            return
        }
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let ciImage = CIImage(cvImageBuffer: pixelBuffer)
        guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
              let jpeg = ciContext.jpegRepresentation(of: ciImage, colorSpace: colorSpace, options: [:]) else { return }
        FrameWriter.shared.write(kind: 2, payload: jpeg)
    }
}

// MARK: - Main

let options = parseArgs()

if options.list {
    runList()
}

if options.noScreen && options.noAudio && options.noMic {
    fail("nothing to capture: --no-screen, --no-audio and --no-mic were all given")
}

// Preflight the mic permission explicitly. SCStreamConfiguration.captureMicrophone
// alone doesn't reliably surface the system prompt for a bare CLI binary, so we
// go through AVCaptureDevice — the standard trigger — before touching SCStream.
if !options.noMic {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .denied, .restricted:
        failPermission(microphoneHelp)
    case .notDetermined:
        if !requestMicrophoneAccessSync() {
            failPermission(microphoneHelp)
        }
    case .authorized:
        break
    @unknown default:
        break
    }
}

let content: SCShareableContent
switch getShareableContentSync() {
case .failure(let error):
    classifyAndFail(error, context: "failed to enumerate shareable content")
case .success(let c):
    content = c
}

guard !content.displays.isEmpty else {
    fail("ScreenCaptureKit returned no displays")
}

let displayIndex = options.displayIndex ?? 0
guard content.displays.indices.contains(displayIndex) else {
    fail("--display \(displayIndex) out of range (0..<\(content.displays.count))")
}
let display = content.displays[displayIndex]

let filter = SCContentFilter(display: display, excludingWindows: [])
let config = SCStreamConfiguration()
config.width = display.width
config.height = display.height
config.minimumFrameInterval = CMTime(value: 1, timescale: Int32(options.fps))
config.showsCursor = true
config.pixelFormat = kCVPixelFormatType_32BGRA
config.queueDepth = 5

if !options.noAudio {
    config.capturesAudio = true
    config.sampleRate = 48000
    config.channelCount = 1
    config.excludesCurrentProcessAudio = true
}

var micEnabled = false
if !options.noMic {
    if #available(macOS 15.0, *) {
        config.captureMicrophone = true
        micEnabled = true
    } else {
        logErr("microphone capture needs macOS 15+ (this Mac is older); continuing without mic")
    }
}

let delegate = CaptureDelegate()
let stream = SCStream(filter: filter, configuration: config, delegate: delegate)

do {
    if !options.noScreen {
        try stream.addStreamOutput(delegate, type: .screen, sampleHandlerQueue: DispatchQueue(label: "iai.screen"))
    }
    if !options.noAudio {
        try stream.addStreamOutput(delegate, type: .audio, sampleHandlerQueue: DispatchQueue(label: "iai.audio"))
    }
    if micEnabled, #available(macOS 15.0, *) {
        try stream.addStreamOutput(delegate, type: .microphone, sampleHandlerQueue: DispatchQueue(label: "iai.mic"))
    }
} catch {
    fail("failed to add stream output: \(error.localizedDescription)")
}

if let startError = startCaptureSync(stream) {
    classifyAndFail(startError, context: "failed to start capture")
}

logErr("capturing screen=\(!options.noScreen) audio=\(!options.noAudio) mic=\(micEnabled) " +
       "display=#\(displayIndex) (\(display.width)x\(display.height)) fps=\(options.fps)")

let appMonitor = AppMonitor()

// GCD signal sources, not a raw signal() handler: only async-signal-safe code
// may run in a real signal handler, and stopping the stream / exiting cleanly
// is not that. Ignore the default disposition, then handle on the main queue.
signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)
let sigintSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
sigintSource.setEventHandler {
    logErr("stopping (SIGINT)")
    stream.stopCapture { _ in exit(0) }
}
sigintSource.resume()
let sigtermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigtermSource.setEventHandler {
    logErr("stopping (SIGTERM)")
    stream.stopCapture { _ in exit(0) }
}
sigtermSource.resume()

RunLoop.main.run()
