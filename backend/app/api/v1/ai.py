"""Claude assistant + voice: settings, tests, host actions on questions, voice controls."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app.models import AuditLog
from app.security.sessions import AdminDep, CurrentAdmin
from app.services.ai_config import (
    MODEL_PRICES,
    SECRET_CLAUDE_KEY,
    SECRET_VBEE_APP_ID,
    SECRET_VBEE_TOKEN,
    AiConfig,
    mask,
)
from app.services.tts_vbee import FakeTts, TtsError, VbeeTts

router = APIRouter(tags=["ai"])


class AiSettingsIn(BaseModel):
    config: AiConfig
    # None = keep the saved secret, "" = remove it
    claude_api_key: str | None = Field(None, max_length=300)
    vbee_app_id: str | None = Field(None, max_length=200)
    vbee_token: str | None = Field(None, max_length=4000)


class ClaudeTestIn(BaseModel):
    api_key: str | None = Field(None, max_length=300)
    model: str = Field(..., max_length=64, pattern=r"^[a-z0-9][a-z0-9.\-]*$")


class VoiceTestIn(BaseModel):
    text: str = Field("Xin chào cả nhà, shop chào mừng các bạn đến với buổi LIVE hôm nay.", min_length=1, max_length=280)
    app_id: str | None = Field(None, max_length=200)
    token: str | None = Field(None, max_length=4000)
    voice_code: str | None = Field(None, max_length=80, pattern=r"^[A-Za-z0-9_\-.]+$")
    speed: float | None = Field(None, ge=0.5, le=1.6)
    on_live: bool = False


class SpeakIn(BaseModel):
    text: str | None = Field(None, max_length=400)


class HoldIn(BaseModel):
    hold: bool


def _settings_out(c) -> dict:
    a = c.assistant
    return {
        "config": a.config.model_dump(),
        "secrets": {"claude_api_key": mask(c.get_setting(SECRET_CLAUDE_KEY)),
                    "vbee_app_id": mask(c.get_setting(SECRET_VBEE_APP_ID)),
                    "vbee_token": mask(c.get_setting(SECRET_VBEE_TOKEN))},
        "models": [{"id": m, "input_usd_per_mtok": p[0], "output_usd_per_mtok": p[1]} for m, p in MODEL_PRICES.items()],
        "status": a.status(), "tts_locked": c.settings.tts_locked,
    }


@router.get("/settings/ai")
def get_settings(request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    return _settings_out(request.app.state.container)


@router.put("/settings/ai")
def put_settings(body: AiSettingsIn, request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    cfg = body.config
    if cfg.voice_enabled and not cfg.voice_policy_confirmed:
        raise HTTPException(422, detail={"code": "policy_not_confirmed",
                                         "message": "Hãy đánh dấu đủ danh sách chính sách trước khi bật giọng đọc."})
    cfg.banned_words = sorted({w.strip() for w in cfg.banned_words if w.strip()})[:200]
    changed = []
    for key, value in ((SECRET_CLAUDE_KEY, body.claude_api_key), (SECRET_VBEE_APP_ID, body.vbee_app_id),
                       (SECRET_VBEE_TOKEN, body.vbee_token)):
        if value is not None:
            c.set_setting(key, value.strip() or None, secret=True)
            changed.append(key)
    was_on = c.assistant.config.voice_enabled
    c.assistant.update_config(cfg)
    if was_on and not cfg.voice_enabled:
        c.speech.kill(mute=False)
    with c.db.session() as s:
        s.add(AuditLog(admin_id=admin.id, action="ai_settings_update", resource="ai_config",
                       detail={"secrets_changed": changed, "voice_enabled": cfg.voice_enabled,
                               "answer_mode": cfg.answer_mode, "model": cfg.model}))
    c.hub.send_dashboard({"type": "AI_STATUS", "ai": c.assistant.status()})
    return _settings_out(c)


@router.post("/settings/ai/test")
async def test_claude(body: ClaudeTestIn, request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    return await c.assistant.test_claude((body.api_key or "").strip() or None, body.model)


@router.post("/settings/voice/test")
async def test_voice(body: VoiceTestIn, request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    a = c.assistant
    if c.settings.fake_ai:
        provider = FakeTts()
    else:
        app_id = (body.app_id or "").strip() or c.get_setting(SECRET_VBEE_APP_ID)
        token = (body.token or "").strip() or c.get_setting(SECRET_VBEE_TOKEN)
        if not app_id or not token:
            return {"ok": False, "message": "Chưa nhập App ID và Token Vbee."}
        provider = VbeeTts(app_id, token)
    voice = body.voice_code or a.config.voice_code
    speed = body.speed or a.config.voice_speed
    if not a.budget.tts_allows(len(body.text), a.config.voice_month_chars):
        return {"ok": False, "message": "Đã hết hạn mức ký tự giọng đọc của tháng."}
    try:
        url = await c.speech.render(body.text, provider, voice, speed)
    except TtsError as exc:
        return {"ok": False, "message": exc.message}
    if body.on_live:
        ok, why = a.voice_ready()
        if not ok:
            return {"ok": True, "url": url, "message": f"Nghe thử được trên máy này, nhưng chưa phát lên LIVE: {why}"}
        c.speech.enqueue("test", body.text)
    return {"ok": True, "url": url, "message": "Tạo giọng thành công."}


@router.post("/ai/suggestions/{event_id}/speak")
async def speak(event_id: str, body: SpeakIn, request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    try:
        out = c.assistant.approve(event_id, body.text, admin.id)
    except KeyError as exc:
        raise HTTPException(404, detail={"code": "not_found", "message": "Câu hỏi không còn trong danh sách."}) from exc
    except ValueError as exc:
        raise HTTPException(422, detail={"code": "bad_reply", "message": str(exc)}) from exc
    with c.db.session() as s:
        s.add(AuditLog(admin_id=admin.id, action="ai_answer_approved", resource=event_id,
                       detail={"spoken": out["spoken"], "edited": body.text is not None}))
    return out


@router.post("/ai/suggestions/{event_id}/dismiss")
async def dismiss(event_id: str, request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    try:
        return {"item": c.assistant.dismiss(event_id)}
    except KeyError as exc:
        raise HTTPException(404, detail={"code": "not_found", "message": "Câu hỏi không còn trong danh sách."}) from exc


@router.get("/voice/state")
def voice_state(request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    return {"speech": c.speech.state(), "ai": c.assistant.status()}


@router.post("/voice/kill")
async def voice_kill(request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    """Kill switch (AI-06): stop at once and stay silent until the host turns the voice back on."""
    c = request.app.state.container
    c.speech.kill()
    with c.db.session() as s:
        s.add(AuditLog(admin_id=admin.id, action="voice_kill", resource="speech", detail=None))
    return {"speech": c.speech.state()}


@router.post("/voice/unmute")
async def voice_unmute(request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    c.speech.unmute()
    return {"speech": c.speech.state()}


@router.post("/voice/hold")
async def voice_hold(body: HoldIn, request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    """The host is talking: pause the clip that is playing and start no new one."""
    c = request.app.state.container
    c.speech.set_hold(body.hold)
    return {"speech": c.speech.state()}
