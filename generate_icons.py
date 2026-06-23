#!/usr/bin/env python3
"""Generate Family Ledger app icons at all required sizes."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

BASE = Path(__file__).parent / "clients/mobile"
BLUE = (26, 115, 232)  # #1A73E8
WHITE = (255, 255, 255)


def draw_logo(draw: ImageDraw.ImageDraw, size: int) -> None:
    """Draw the logo on an already-blue background.

    Layout (all values proportional to `size`):
      - House roof: isoceles triangle, peak at top-center
      - House body: rectangle below roof
      - 3 ascending bars (blue = same as bg = negative space in white house)
    """
    pad = size * 0.12  # outer padding from edge to house
    peak_y = size * 0.14  # roof peak Y
    roof_base_y = size * 0.50  # where roof meets body
    body_bottom = size * 0.88  # bottom of house body
    cx = size / 2  # horizontal center

    # --- House (solid white) ---
    # Roof: triangle
    roof = [
        (cx, peak_y),
        (size - pad, roof_base_y),
        (pad, roof_base_y),
    ]
    draw.polygon(roof, fill=WHITE)

    # Body: rectangle (slightly narrower than roof base)
    body_pad = size * 0.17
    draw.rectangle(
        [(body_pad, roof_base_y), (size - body_pad, body_bottom)],
        fill=WHITE,
    )

    # --- 3 ascending bars (BLUE = cuts through white) ---
    bar_w = size * 0.10
    bar_gap = size * 0.055
    # Center the three bars horizontally in the body
    total_bars_w = 3 * bar_w + 2 * bar_gap
    bar_x0 = cx - total_bars_w / 2

    bar_heights = [size * 0.16, size * 0.24, size * 0.32]
    bar_bottom = body_bottom - size * 0.04
    radius = max(1, int(size * 0.018))

    for i, bh in enumerate(bar_heights):
        x = bar_x0 + i * (bar_w + bar_gap)
        y_top = bar_bottom - bh
        draw.rounded_rectangle(
            [(x, y_top), (x + bar_w, bar_bottom)],
            radius=radius,
            fill=BLUE,
        )


def make_icon(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Rounded-square blue background
    corner = size * 0.22
    draw.rounded_rectangle([(0, 0), (size - 1, size - 1)], radius=corner, fill=BLUE)

    draw_logo(draw, size)
    return img


def save(img: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "PNG")
    print(f"  {path.relative_to(BASE.parent)}")


def main() -> None:
    print("Generating Android icons…")
    android_res = BASE / "android/app/src/main/res"
    android_sizes = {
        "mipmap-mdpi": 48,
        "mipmap-hdpi": 72,
        "mipmap-xhdpi": 96,
        "mipmap-xxhdpi": 144,
        "mipmap-xxxhdpi": 192,
    }
    for folder, px in android_sizes.items():
        img = make_icon(px)
        save(img, android_res / folder / "ic_launcher.png")
        # foreground variant (for adaptive icons) — same image
        save(img, android_res / folder / "ic_launcher_foreground.png")

    print("Generating iOS icons…")
    ios_dir = BASE / "ios/Runner/Assets.xcassets/AppIcon.appiconset"
    ios_sizes = {
        "Icon-App-20x20@1x.png": 20,
        "Icon-App-20x20@2x.png": 40,
        "Icon-App-20x20@3x.png": 60,
        "Icon-App-29x29@1x.png": 29,
        "Icon-App-29x29@2x.png": 58,
        "Icon-App-29x29@3x.png": 87,
        "Icon-App-40x40@2x.png": 80,
        "Icon-App-40x40@3x.png": 120,
        "Icon-App-60x60@2x.png": 120,
        "Icon-App-60x60@3x.png": 180,
        "Icon-App-1024x1024@1x.png": 1024,
    }
    for filename, px in ios_sizes.items():
        img = make_icon(px)
        # iOS icons must not have transparency
        flat = Image.new("RGB", (px, px), BLUE)
        flat.paste(img, mask=img.split()[3])
        save(flat, ios_dir / filename)

    print("Done.")


if __name__ == "__main__":
    main()
