"""Rasterize the 1C linked-ring mark into build/icon.png and build/icon.ico."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

GREEN = (15, 107, 76, 255)
INK = (26, 26, 26, 255)
CREAM = (239, 233, 221, 255)

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "build"
SRC_ASSETS = ROOT / "src" / "assets"


def draw_rings(
    draw: ImageDraw.ImageDraw,
    size: int,
    *,
    solid: bool,
) -> None:
    # Geometry from EZAFF Logo.dc.html 2B (128px: ring 46, stroke 8, overlap 14).
    if solid:
        d = max(6, round(size * 9 / 16))
        overlap = max(2, round(size * 3 / 16))
        y = (size - d) // 2
        x0 = (size - (d * 2 - overlap)) // 2
        draw.ellipse((x0, y, x0 + d, y + d), fill=GREEN)
        draw.ellipse((x0 + d - overlap, y, x0 + d - overlap + d, y + d), fill=INK)
        return

    ring = round(size * 46 / 128)
    stroke = max(2, round(size * 8 / 128))
    overlap = round(size * 14 / 128)
    total = ring * 2 - overlap
    x0 = (size - total) // 2
    y0 = (size - ring) // 2

    def ring_box(x: int) -> tuple[int, int, int, int]:
        return (x, y0, x + ring - 1, y0 + ring - 1)

    draw.ellipse(ring_box(x0), outline=GREEN, width=stroke)
    draw.ellipse(ring_box(x0 + ring - overlap), outline=INK, width=stroke)


def render(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), CREAM)
    draw = ImageDraw.Draw(img)
    draw_rings(draw, size, solid=size <= 20)
    return img


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    SRC_ASSETS.mkdir(parents=True, exist_ok=True)

    hero = render(512)
    hero.save(OUT_DIR / "icon.png", format="PNG")
    hero.resize((128, 128), Image.Resampling.LANCZOS).save(
        SRC_ASSETS / "icon.png",
        format="PNG",
    )

    sizes = (16, 24, 32, 48, 64, 128, 256)
    frames = [render(s) for s in sizes]
    frames[-1].save(
        OUT_DIR / "icon.ico",
        format="ICO",
        sizes=[(s, s) for s in sizes],
        append_images=frames[:-1],
    )
    print(f"wrote {OUT_DIR / 'icon.png'}")
    print(f"wrote {OUT_DIR / 'icon.ico'}")
    print(f"wrote {SRC_ASSETS / 'icon.png'}")


if __name__ == "__main__":
    main()
