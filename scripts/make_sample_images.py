"""Generate the placeholder front-of-box images in assets/sample-products/.

These are clearly labelled DEMO artwork for a fictional shop so the 3D demo works out of
the box. Replace them with photos of the real packaging in the dashboard (SPEC H2)."""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "assets" / "sample-products"
FONT_DIRS = [Path("/usr/share/fonts/truetype/dejavu"), Path("C:/Windows/Fonts")]

PRODUCTS = [
    ("tra_ca_gai_leo.png", "TRÀ", "CÀ GAI LEO", (196, 232, 202), (46, 110, 64)),
    ("tra_ba_kich.png", "TRÀ", "BA KÍCH", (246, 214, 226), (140, 46, 84)),
]


def font(size: int, bold: bool = True) -> ImageFont.FreeTypeFont:
    names = ["DejaVuSans-Bold.ttf", "arialbd.ttf"] if bold else ["DejaVuSans.ttf", "arial.ttf"]
    for d in FONT_DIRS:
        for n in names:
            if (d / n).exists():
                return ImageFont.truetype(str(d / n), size)
    sys.exit("No TrueType font found (DejaVu or Arial).")


def centered(draw: ImageDraw.ImageDraw, y: int, text: str, f, fill, width: int) -> None:
    w = draw.textlength(text, font=f)
    draw.text(((width - w) / 2, y), text, font=f, fill=fill)


def make(name: str, line1: str, line2: str, bg, ink) -> None:
    W, H = 500, 700
    img = Image.new("RGB", (W, H), bg)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((24, 24, W - 24, H - 24), radius=36, outline=ink, width=8)
    d.rectangle((24, 120, W - 24, 132), fill=ink)
    centered(d, 52, "TẠP HÓA CHIBI", font(40), ink, W)
    # simple leaf mark
    cx, cy = W // 2, 270
    d.ellipse((cx - 90, cy - 50, cx + 90, cy + 50), fill=ink)
    d.line((cx - 80, cy, cx + 80, cy), fill=bg, width=6)
    centered(d, 360, line1, font(64), ink, W)
    centered(d, 440, line2, font(56), ink, W)
    d.rounded_rectangle((50, 560, W - 50, 630), radius=18, fill=ink)
    centered(d, 578, "SẢN PHẨM MẪU · DEMO", font(26), bg, W)
    OUT.mkdir(parents=True, exist_ok=True)
    img.save(OUT / name, optimize=True)
    print("wrote", OUT / name)


if __name__ == "__main__":
    for p in PRODUCTS:
        make(*p)
