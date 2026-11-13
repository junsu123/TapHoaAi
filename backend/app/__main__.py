"""`python -m app` — start the server on CHIBI_HOST:CHIBI_PORT (default 127.0.0.1:8686).

Change the port with the CHIBI_PORT environment variable, backend/.env, or --port:
    python -m app --port 9090
"""

from __future__ import annotations

import argparse
import socket
import sys

import uvicorn

from app.config import get_settings


def port_is_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((host, port))
            return True
        except OSError:
            return False


def main() -> None:
    settings = get_settings()
    ap = argparse.ArgumentParser(prog="python -m app")
    ap.add_argument("--host", default=settings.host)
    ap.add_argument("--port", type=int, default=settings.port)
    args = ap.parse_args()
    if not port_is_free(args.host, args.port):
        sys.exit(f"Cổng {args.port} đang bị chương trình khác dùng. "
                 f"Chọn cổng khác, ví dụ: python -m app --port {args.port + 1}")
    print(f"Dashboard: http://{args.host}:{args.port}/dashboard")
    print(f"Game/OBS : http://{args.host}:{args.port}/game/live")
    uvicorn.run("app.main:app", host=args.host, port=args.port)


if __name__ == "__main__":
    main()
