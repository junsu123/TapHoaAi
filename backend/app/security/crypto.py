"""At-rest encryption for secrets in the settings table (NFR-06).

The Fernet key lives in CHIBI_SECRET_KEY or <data_dir>/secret.key (created with 0600
permissions on first run). Back the key file up separately from the database."""

from __future__ import annotations

import os
import re
from pathlib import Path

from cryptography.fernet import Fernet


def load_or_create_key(data_dir: Path) -> bytes:
    env = os.environ.get("CHIBI_SECRET_KEY")
    if env:
        return env.encode()
    data_dir.mkdir(parents=True, exist_ok=True)
    path = data_dir / "secret.key"
    if path.exists():
        return path.read_bytes().strip()
    key = Fernet.generate_key()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(key)
    return key


class SecretBox:
    def __init__(self, key: bytes):
        self._f = Fernet(key)

    def encrypt(self, plaintext: str) -> str:
        return self._f.encrypt(plaintext.encode()).decode()

    def decrypt(self, token: str) -> str:
        return self._f.decrypt(token.encode()).decode()


def mask_secret(value: str | None) -> str | None:
    if not value:
        return None
    tail = value[-4:] if len(value) >= 8 else ""
    return f"{value[:3]}…{tail}" if tail else "••••"


_SECRET_PATTERNS = [re.compile(r"sk-ant-[A-Za-z0-9_\-]{8,}"), re.compile(r"sk-[A-Za-z0-9_\-]{16,}")]


def redact(text: str) -> str:
    """Remove anything that looks like an API key before logging."""
    for pat in _SECRET_PATTERNS:
        text = pat.sub("[REDACTED]", text)
    return text
