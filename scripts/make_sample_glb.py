"""Write assets/sample-products/sample_tin.glb — a tiny tea-tin model (cylinder body, lid)
used by tests and as a GLB upload example. Pure Python, no 3D tools needed."""

from __future__ import annotations

import json
import math
import struct
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "assets" / "sample-products" / "sample_tin.glb"


def cylinder(r: float, y0: float, y1: float, n: int = 40):
    pos, nor, idx = [], [], []
    for i in range(n + 1):  # side
        a = 2 * math.pi * i / n
        x, z = math.cos(a), math.sin(a)
        pos += [(r * x, y0, r * z), (r * x, y1, r * z)]
        nor += [(x, 0, z), (x, 0, z)]
    for i in range(n):
        b = 2 * i
        idx += [b, b + 1, b + 2, b + 1, b + 3, b + 2]
    for y, ny in ((y1, 1.0), (y0, -1.0)):  # caps
        c = len(pos)
        pos.append((0, y, 0))
        nor.append((0, ny, 0))
        for i in range(n + 1):
            a = 2 * math.pi * i / n
            pos.append((r * math.cos(a), y, r * math.sin(a)))
            nor.append((0, ny, 0))
        for i in range(n):
            idx += [c, c + 1 + i + 1, c + 1 + i] if ny > 0 else [c, c + 1 + i, c + 1 + i + 1]
    return pos, nor, idx


def build_glb() -> bytes:
    parts = [cylinder(0.5, 0.0, 0.88), cylinder(0.53, 0.88, 1.0)]  # body, lid
    colors = [(0.36, 0.72, 0.52, 1.0), (0.96, 0.84, 0.42, 1.0)]
    blob = bytearray()
    views, accessors, meshes_prims = [], [], []
    for (pos, nor, idx), _ in zip(parts, colors, strict=True):
        def add(data: bytes, target: int) -> int:
            while len(blob) % 4:
                blob.append(0)
            views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(data), "target": target})
            blob.extend(data)
            return len(views) - 1
        pv = add(b"".join(struct.pack("<3f", *p) for p in pos), 34962)
        nv = add(b"".join(struct.pack("<3f", *n) for n in nor), 34962)
        iv = add(b"".join(struct.pack("<H", i) for i in idx), 34963)
        xs, ys, zs = zip(*pos, strict=True)
        accessors += [
            {"bufferView": pv, "componentType": 5126, "count": len(pos), "type": "VEC3",
             "min": [min(xs), min(ys), min(zs)], "max": [max(xs), max(ys), max(zs)]},
            {"bufferView": nv, "componentType": 5126, "count": len(nor), "type": "VEC3"},
            {"bufferView": iv, "componentType": 5123, "count": len(idx), "type": "SCALAR"},
        ]
        a0 = len(accessors) - 3
        meshes_prims.append({"attributes": {"POSITION": a0, "NORMAL": a0 + 1}, "indices": a0 + 2,
                             "material": len(meshes_prims)})
    doc = {
        "asset": {"version": "2.0", "generator": "chibi-live-shop sample"},
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0, "name": "sample_tin"}],
        "meshes": [{"primitives": meshes_prims}],
        "materials": [{"pbrMetallicRoughness": {"baseColorFactor": c, "metallicFactor": 0.1, "roughnessFactor": 0.6}}
                      for c in colors],
        "buffers": [{"byteLength": len(blob)}], "bufferViews": views, "accessors": accessors,
    }
    js = json.dumps(doc, separators=(",", ":")).encode()
    js += b" " * ((4 - len(js) % 4) % 4)
    while len(blob) % 4:
        blob.append(0)
    total = 12 + 8 + len(js) + 8 + len(blob)
    return (b"glTF" + struct.pack("<II", 2, total) + struct.pack("<II", len(js), 0x4E4F534A) + js
            + struct.pack("<II", len(blob), 0x004E4942) + bytes(blob))


if __name__ == "__main__":
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(build_glb())
    print("wrote", OUT, OUT.stat().st_size, "bytes")
