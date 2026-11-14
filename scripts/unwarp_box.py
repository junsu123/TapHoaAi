"""Cut flat, straight face textures out of a 3D box mockup / photo.

    python scripts/unwarp_box.py mockup.jpg --front 421,210 981,261 981,1098 420,1144 \
        --left 270,248 421,210 420,1144 270,1101 --size 12x17x5.2 --out out_dir

Corners are given clockwise from top-left (top-left, top-right, bottom-right, bottom-left)
in image pixels. --size is the real box W x H x D (cm) and only sets the output aspect
ratios. Writes front.png, left.png (and right/back/top when given).

The result keeps the mockup's lighting and is softer on steep faces; for the sharpest
result export the faces straight from the print design file (PDF/AI dieline) instead.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image

FACES = ("front", "back", "left", "right", "top")


def coeffs(dst: list[tuple[float, float]], src: list[tuple[float, float]]) -> list[float]:
    """PIL perspective coefficients mapping output (dst) pixels to input (src) pixels."""
    rows, rhs = [], []
    for (x, y), (u, v) in zip(dst, src, strict=True):
        rows.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); rhs.append(u)
        rows.append([0, 0, 0, x, y, 1, -v * x, -v * y]); rhs.append(v)
    return list(np.linalg.solve(np.array(rows, float), np.array(rhs, float)))


def unwarp(img: Image.Image, corners: list[tuple[float, float]], w: int, h: int) -> Image.Image:
    dst = [(0, 0), (w, 0), (w, h), (0, h)]
    return img.transform((w, h), Image.Transform.PERSPECTIVE, coeffs(dst, corners), Image.Resampling.BICUBIC)


def parse_pts(vals: list[str]) -> list[tuple[float, float]]:
    pts = [tuple(float(c) for c in v.split(",")) for v in vals]
    if len(pts) != 4:
        raise SystemExit("each face needs 4 corners: TL TR BR BL")
    return pts  # type: ignore[return-value]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("image", type=Path)
    for f in FACES:
        ap.add_argument(f"--{f}", nargs=4, metavar="X,Y")
    ap.add_argument("--size", default="12x17x5", help="real box W x H x D in cm")
    ap.add_argument("--height-px", type=int, default=1024)
    ap.add_argument("--out", type=Path, default=Path("faces"))
    a = ap.parse_args()
    W, H, D = (float(x) for x in a.size.lower().split("x"))
    img = Image.open(a.image).convert("RGB")
    a.out.mkdir(parents=True, exist_ok=True)
    hp = a.height_px
    dims = {"front": (W, H), "back": (W, H), "left": (D, H), "right": (D, H), "top": (W, D)}
    for f in FACES:
        pts = getattr(a, f)
        if not pts:
            continue
        fw, fh = dims[f]
        out = unwarp(img, parse_pts(pts), round(hp * fw / H), round(hp * fh / H))
        out.save(a.out / f"{f}.png", optimize=True)
        print("wrote", a.out / f"{f}.png", out.size)


if __name__ == "__main__":
    main()
