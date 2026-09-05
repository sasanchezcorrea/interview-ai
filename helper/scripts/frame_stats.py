#!/usr/bin/env python3
"""Verification tool for iai-capture's stdout wire protocol.

Reads the length-prefixed frame stream (see helper/README.md for the format)
either from stdin or from a file given as argv[1], counts frames per kind,
and computes the RMS of the PCM audio kinds (0 = system audio, 1 = mic) so a
human can tell "silence, correctly captured" apart from "capture is broken".

ponytail: stdlib only (struct + sys), no third-party deps — this is a
throwaway verification script, not shipped product code.
"""
import struct
import sys
import math

MAGIC = 0x49  # 'I'
KIND_NAMES = {0: "system_audio", 1: "microphone", 2: "screenshot", 3: "status"}


def read_exact(f, n):
    buf = b""
    while len(buf) < n:
        chunk = f.read(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


def rms_int16(payload: bytes) -> float:
    if not payload:
        return 0.0
    count = len(payload) // 2
    if count == 0:
        return 0.0
    samples = struct.unpack(f"<{count}h", payload[: count * 2])
    total = sum(s * s for s in samples)
    return math.sqrt(total / count)


def main():
    src = open(sys.argv[1], "rb") if len(sys.argv) > 1 else sys.stdin.buffer
    counts = {}
    bytes_by_kind = {}
    rms_sum = {}
    rms_n = {}
    statuses = []

    while True:
        header = read_exact(src, 6)
        if header is None:
            break
        magic, kind, length = struct.unpack("<BBI", header)
        if magic != MAGIC:
            print(f"!! bad magic {magic:#x}, stream desynced, stopping", file=sys.stderr)
            break
        payload = read_exact(src, length)
        if payload is None:
            print("!! truncated payload at EOF", file=sys.stderr)
            break
        counts[kind] = counts.get(kind, 0) + 1
        bytes_by_kind[kind] = bytes_by_kind.get(kind, 0) + length
        if kind in (0, 1):
            r = rms_int16(payload)
            rms_sum[kind] = rms_sum.get(kind, 0.0) + r
            rms_n[kind] = rms_n.get(kind, 0) + 1
        if kind == 3:
            statuses.append(payload.decode("utf-8", "replace"))

    print("=== frame counts ===")
    for kind in sorted(counts):
        name = KIND_NAMES.get(kind, f"kind{kind}")
        print(f"  kind {kind} ({name}): {counts[kind]} frames, {bytes_by_kind[kind]} bytes")
    print("=== audio RMS (mean per-frame RMS, int16 scale 0-32767) ===")
    for kind in (0, 1):
        name = KIND_NAMES[kind]
        if rms_n.get(kind):
            print(f"  {name}: mean RMS = {rms_sum[kind] / rms_n[kind]:.2f} over {rms_n[kind]} frames")
        else:
            print(f"  {name}: no frames received")
    if statuses:
        print("=== status frames ===")
        for s in statuses:
            print(f"  {s}")


if __name__ == "__main__":
    main()
