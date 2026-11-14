from __future__ import annotations

import hmac
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.security.sessions import is_loopback, websocket_admin

router = APIRouter()
log = logging.getLogger("chibi.ws")

CLIENT_ACTION_TYPES = {"ACK", "ACTION_STARTED", "ACTION_PROGRESS", "ACTION_COMPLETED", "ACTION_FAILED"}


@router.websocket("/ws/game")
async def ws_game(ws: WebSocket) -> None:
    c = ws.app.state.container
    host = ws.client.host if ws.client else None
    token = ws.query_params.get("token", "")
    if not (is_loopback(host) or (token and hmac.compare_digest(token, c.game_token))):
        await ws.close(code=4401)
        return
    await ws.accept()
    role = "primary" if ws.query_params.get("role") == "primary" else "viewer"
    became_primary = c.hub.game.add(ws, role)
    if became_primary:
        c.hub.on_primary_changed()
    try:
        c.hub.game.send_to(ws, c.game_snapshot())
        while True:
            msg = await ws.receive_json()
            if not isinstance(msg, dict):
                continue
            mtype = msg.get("type")
            if mtype == "PING":
                c.hub.game.send_to(ws, {"type": "PONG", "sequence": c.hub.game.sequence})
            elif mtype == "RESYNC":
                c.hub.game.send_to(ws, c.game_snapshot())
            elif mtype in CLIENT_ACTION_TYPES:
                if c.hub.game.role_of(ws) == "primary":  # D3: only the primary may ACK
                    c.actions.on_client_message(msg)
            elif mtype in ("SPEECH_STARTED", "SPEECH_ENDED", "SPEECH_FAILED"):
                if c.hub.game.role_of(ws) == "primary":  # only the OBS page plays the voice
                    c.speech.on_client_message(msg)
            elif mtype == "FPS_REPORT" and c.hub.game.role_of(ws) == "primary":
                c.fps_reports.append({"fps": msg.get("fps"), "quality": msg.get("quality"),
                                      "avatars": msg.get("avatars")})
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001
        log.info("game websocket closed with error", exc_info=True)
    finally:
        c.hub.game.remove(ws)


@router.websocket("/ws/dashboard")
async def ws_dashboard(ws: WebSocket) -> None:
    c = ws.app.state.container
    if websocket_admin(ws) is None:
        await ws.close(code=4401)
        return
    await ws.accept()
    c.hub.dashboard.add(ws, "viewer")
    try:
        c.hub.dashboard.send_to(ws, c.dashboard_snapshot())
        c.hub.dashboard.send_to(ws, {"type": "METRICS", "metrics": c.metrics()})
        while True:
            msg = await ws.receive_json()
            if isinstance(msg, dict) and msg.get("type") == "RESYNC":
                c.hub.dashboard.send_to(ws, c.dashboard_snapshot())
            elif isinstance(msg, dict) and msg.get("type") == "PING":
                c.hub.dashboard.send_to(ws, {"type": "PONG"})
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001
        log.info("dashboard websocket closed with error", exc_info=True)
    finally:
        c.hub.dashboard.remove(ws)
