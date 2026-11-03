#!/usr/bin/env python3
"""Draw the home-screen icons. No third-party libraries."""

import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "public" / "icons"
GREEN = (27, 67, 50, 255)
CLAY = (212, 83, 43, 255)
PAPER = (255, 250, 244, 255)


def chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def png(size, pixel):
    raw = bytearray()
    for y in range(size):
        raw.append(0)
        for x in range(size):
            raw.extend(pixel(x, y, size))
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")


def shutter(x, y, size):
    cx = (size - 1) / 2
    cy = (size - 1) / 2
    distance = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
    inner = size * 0.075
    ring_inner = size * 0.16
    ring_outer = size * 0.25
    if distance <= inner:
        return CLAY
    if distance <= ring_inner:
        return PAPER
    if distance <= ring_outer:
        return CLAY
    return GREEN


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    (ROOT / "icon-192.png").write_bytes(png(192, shutter))
    (ROOT / "icon-512.png").write_bytes(png(512, shutter))
    (ROOT / "icon-maskable.png").write_bytes(png(512, shutter))
    (ROOT / "apple-touch-icon.png").write_bytes(png(180, shutter))


if __name__ == "__main__":
    main()
