#!/usr/bin/env python3
"""Generate pyrunner app icons (64, 128, 256 px)."""

import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UI_IMAGES = ROOT / "app" / "ui" / "images"


def create_png(width, height, pixels):
    """Create a PNG file from RGBA pixel data (list of (r,g,b,a) tuples)."""
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    raw_rows = []
    for y in range(height):
        row = b"\x00"
        for x in range(width):
            r, g, b, a = pixels[y * width + x]
            row += bytes([r, g, b, a])
        raw_rows.append(row)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", ihdr)
    png += chunk(b"IDAT", zlib.compress(b"".join(raw_rows), 9))
    png += chunk(b"IEND", b"")
    return png


def draw_icon(size):
    pixels = [(0, 0, 0, 0)] * (size * size)
    cx, cy = size / 2, size / 2
    radius = size * 0.42

    for y in range(size):
        for x in range(size):
            dx, dy = x - cx + 0.5, y - cy + 0.5
            dist = (dx * dx + dy * dy) ** 0.5

            if dist <= radius:
                # Python blue gradient
                t = (y / size)
                r = int(55 + t * 20)
                g = int(118 - t * 30)
                b = int(171 + t * 20)
                pixels[y * size + x] = (r, g, b, 255)
            elif dist <= radius + 1.5:
                alpha = int(255 * (1 - (dist - radius) / 1.5))
                pixels[y * size + x] = (55, 118, 171, max(0, alpha))

    # Draw "Py" text area (simplified white shapes)
    scale = size / 64.0
    # P vertical bar
    for y in range(int(16 * scale), int(48 * scale)):
        for x in range(int(18 * scale), int(24 * scale)):
            if 0 <= x < size and 0 <= y < size:
                pixels[y * size + x] = (255, 255, 255, 255)
    # P top and middle bar
    for y in range(int(16 * scale), int(22 * scale)):
        for x in range(int(18 * scale), int(34 * scale)):
            if 0 <= x < size and 0 <= y < size:
                pixels[y * size + x] = (255, 255, 255, 255)
    for y in range(int(28 * scale), int(34 * scale)):
        for x in range(int(18 * scale), int(34 * scale)):
            if 0 <= x < size and 0 <= y < size:
                pixels[y * size + x] = (255, 255, 255, 255)

    # y
    for y in range(int(28 * scale), int(48 * scale)):
        for x in range(int(38 * scale), int(44 * scale)):
            if 0 <= x < size and 0 <= y < size:
                pixels[y * size + x] = (255, 255, 255, 255)
    for i in range(int(10 * scale)):
        y = int(28 * scale) + i
        x1 = int(38 * scale) - i
        x2 = int(44 * scale) + i
        for x in range(max(0, x1), min(size, x2)):
            if 0 <= y < size:
                pixels[y * size + x] = (255, 255, 255, 255)

    return pixels


def main():
    UI_IMAGES.mkdir(parents=True, exist_ok=True)

    for size in (64, 128, 256):
        png_data = create_png(size, size, draw_icon(size))
        out = UI_IMAGES / f"icon_{size}.png"
        out.write_bytes(png_data)
        print(f"Created {out}")

    # Root level icons for fnpack
    png_64 = create_png(64, 64, draw_icon(64))
    png_256 = create_png(256, 256, draw_icon(256))
    (ROOT / "ICON.PNG").write_bytes(png_64)
    (ROOT / "ICON_256.PNG").write_bytes(png_256)
    print(f"Created {ROOT / 'ICON.PNG'}")
    print(f"Created {ROOT / 'ICON_256.PNG'}")


if __name__ == "__main__":
    main()
