"""Validated media storage (NFR-08, SPEC H2).

Images are re-encoded with Pillow (drops metadata and any payload hidden after the image),
GLB files are checked for the binary glTF header and rejected if they reference external
URIs. Stored as <sha256[:2]>/<sha256>.<ext>; user-supplied file names are never used."""

from __future__ import annotations

import hashlib
import io
import json
import struct
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, UnidentifiedImageError

MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_GLB_BYTES = 20 * 1024 * 1024
MAX_IMAGE_SIDE = 2048
ALLOWED_IMAGE_FORMATS = {"PNG", "JPEG", "WEBP"}


class MediaError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class StoredMedia:
    kind: str
    rel_path: str
    sha256: str
    mime: str
    size_bytes: int


def _store(media_dir: Path, data: bytes, ext: str, kind: str, mime: str) -> StoredMedia:
    digest = hashlib.sha256(data).hexdigest()
    rel = f"{digest[:2]}/{digest}.{ext}"
    path = media_dir / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(data)
        tmp.replace(path)
    return StoredMedia(kind, rel, digest, mime, len(data))


def store_image(media_dir: Path, data: bytes) -> StoredMedia:
    if len(data) > MAX_IMAGE_BYTES:
        raise MediaError("too_large", "Ảnh vượt quá 5 MB.")
    try:
        img = Image.open(io.BytesIO(data))
        fmt = img.format
        img.load()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise MediaError("bad_image", "File không phải ảnh hợp lệ (PNG, JPEG, WebP).") from exc
    if fmt not in ALLOWED_IMAGE_FORMATS:
        raise MediaError("bad_format", "Chỉ nhận ảnh PNG, JPEG hoặc WebP.")
    img = img.convert("RGBA") if img.mode in ("P", "LA", "RGBA") else img.convert("RGB")
    img.thumbnail((MAX_IMAGE_SIDE, MAX_IMAGE_SIDE))
    out = io.BytesIO()
    img.save(out, format="PNG", optimize=True)
    return _store(media_dir, out.getvalue(), "png", "image", "image/png")


def store_generated_jpeg(media_dir: Path, data: bytes) -> StoredMedia:
    """A JPEG the server rendered itself (e.g. a box face from a print PDF)."""
    return _store(media_dir, data, "jpg", "image", "image/jpeg")


def store_glb(media_dir: Path, data: bytes) -> StoredMedia:
    if len(data) > MAX_GLB_BYTES:
        raise MediaError("too_large", "File GLB vượt quá 20 MB.")
    if len(data) < 20 or data[:4] != b"glTF":
        raise MediaError("bad_glb", "File không phải GLB (binary glTF) hợp lệ.")
    version, length = struct.unpack_from("<II", data, 4)
    if version != 2 or length != len(data):
        raise MediaError("bad_glb", "GLB không đúng chuẩn glTF 2.0.")
    chunk_len, chunk_type = struct.unpack_from("<II", data, 12)
    if chunk_type != 0x4E4F534A:  # 'JSON'
        raise MediaError("bad_glb", "GLB thiếu phần JSON.")
    try:
        doc = json.loads(data[20 : 20 + chunk_len].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise MediaError("bad_glb", "Phần JSON của GLB bị lỗi.") from exc
    for key in ("buffers", "images"):
        for item in doc.get(key, []) or []:
            uri = item.get("uri")
            if uri and not uri.startswith("data:"):
                raise MediaError("external_uri", "GLB tham chiếu tài nguyên bên ngoài — không được phép.")
    return _store(media_dir, data, "glb", "model", "model/gltf-binary")
