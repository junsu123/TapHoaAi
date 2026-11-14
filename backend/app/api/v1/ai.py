"""Claude assistant + voice: settings, tests, host actions on questions, voice controls."""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, field_validator

from app.models import AuditLog
from app.security.sessions import AdminDep, CurrentAdmin
from app.services.ai_config import (
    MODEL_PRICES,
    SECRET_CLAUDE_KEY,
    SECRET_VBEE_APP_ID,
    SECRET_VBEE_TOKEN,
    AiConfig,
    check_voice_code,
    mask,
)
from app.services.tts_vbee import FakeTts, TtsError, VbeeTts, list_voices

router = APIRouter(tags=["ai"])
log = logging.getLogger("chibi.voice")


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
    voice_code: str | None = Field(None, max_length=120)
    speed: float | None = Field(None, ge=0.5, le=1.6)
    on_live: bool = False

    _voice = field_validator("voice_code")(classmethod(lambda cls, v: check_voice_code(v)))


class VoiceListIn(BaseModel):
    app_id: str | None = Field(None, max_length=200)
    token: str | None = Field(None, max_length=4000)
    language_code: str | None = Field("vi-VN", max_length=12)


FAKE_VOICES = [
    {"code": "hn_female_ngochuyen_full_48k-fhg", "name": "HN - Ngọc Huyền", "gender": "female", "language_code": "vi-VN",
     "demo": None, "credit_factor": 1, "ownership": "VBEE"},
    {"code": "sg_male_minhhoang_full_48k-fhg", "name": "SG - Minh Hoàng", "gender": "male", "language_code": "vi-VN",
     "demo": None, "credit_factor": 1, "ownership": "VBEE"},
    {"code": "personal:shop-moctam/giong-chu-shop", "name": "Giọng chủ shop (giọng của tôi)", "gender": "female",
     "language_code": "vi-VN", "demo": None, "credit_factor": 1.5, "ownership": "PERSONAL"},
]


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
        log.warning("Nghe thử giọng thất bại: %s", exc.message, extra={"ctx": {"giọng": voice, "HTTP": exc.status}})
        return {"ok": False, "message": exc.message}
    if body.on_live:
        ok, why = a.voice_ready()
        if not ok:
            return {"ok": True, "url": url, "message": f"Nghe thử được trên máy này, nhưng chưa phát lên LIVE: {why}"}
        c.speech.enqueue("test", body.text)
    return {"ok": True, "url": url, "message": "Tạo giọng thành công."}


@router.post("/settings/voice/list")
async def voice_list(body: VoiceListIn, request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    """The voices this Vbee app may use, to pick one instead of typing its code."""
    c = request.app.state.container
    if c.settings.fake_ai:
        return {"ok": True, "voices": FAKE_VOICES, "message": "Danh sách giọng thử (CHIBI_FAKE_AI)."}
    app_id = (body.app_id or "").strip() or c.get_setting(SECRET_VBEE_APP_ID)
    token = (body.token or "").strip() or c.get_setting(SECRET_VBEE_TOKEN)
    try:
        voices = await list_voices(app_id or "", token or "", body.language_code or None)
    except TtsError as exc:
        log.warning("Lấy danh sách giọng Vbee thất bại: %s", exc.message, extra={"ctx": {"HTTP": exc.status}})
        return {"ok": False, "voices": [], "message": exc.message}
    return {"ok": True, "voices": [v.as_dict() for v in voices],
            "message": f"Tìm thấy {len(voices)} giọng." if voices else "Vbee không trả về giọng nào cho ngôn ngữ này."}


class VoiceDiagnoseIn(BaseModel):
    app_id: str | None = Field(None, max_length=200)
    token: str | None = Field(None, max_length=4000)
    voice_code: str | None = Field(None, max_length=120)

    _voice = field_validator("voice_code")(classmethod(lambda cls, v: check_voice_code(v) if v else None))


@router.post("/settings/voice/diagnose")
async def voice_diagnose(body: VoiceDiagnoseIn, request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    """Step by step: list the voices, read a short text with the chosen voice, the default
    voice and a few listed ones — report Vbee's own words for each, and the first voice that works."""
    c = request.app.state.container
    a = c.assistant
    chosen = body.voice_code or a.config.voice_code
    steps: list[dict] = []
    working: str | None = None
    if c.settings.fake_ai:
        voices = [v["code"] for v in FAKE_VOICES]
        return {"steps": [{"name": "Chế độ thử (CHIBI_FAKE_AI)", "ok": True, "detail": "Không gọi Vbee thật."}],
                "working_voice": chosen if chosen in voices else voices[0], "voices": len(voices)}
    app_id = (body.app_id or "").strip() or c.get_setting(SECRET_VBEE_APP_ID)
    token = (body.token or "").strip() or c.get_setting(SECRET_VBEE_TOKEN)
    if not app_id or not token:
        return {"steps": [{"name": "App ID / Token", "ok": False, "detail": "Chưa nhập App ID và Token Vbee."}],
                "working_voice": None, "voices": 0}
    steps.append({"name": "App ID / Token", "ok": True, "detail": f"App ID {mask(app_id)}, token {len(token)} ký tự."})

    listed: list[str] = []
    try:
        vs = await list_voices(app_id, token, "vi-VN")
        listed = [v.code for v in vs]
        steps.append({"name": "Lấy danh sách giọng", "ok": True,
                      "detail": f"{len(listed)} giọng tiếng Việt. Giọng đang chọn "
                                + ("CÓ" if chosen in listed else "KHÔNG có") + " trong danh sách."})
    except TtsError as exc:
        steps.append({"name": "Lấy danh sách giọng", "ok": False, "detail": exc.message, "status": exc.status})

    tts = VbeeTts(app_id, token)
    tried: list[str] = []
    candidates = [chosen, "hn_female_ngochuyen_full_48k-fhg", *listed[:4]]
    for code in candidates:
        if code in tried or len(tried) >= 4:
            continue
        tried.append(code)
        label = "giọng đang chọn" if code == chosen else ("giọng mặc định" if code.startswith("hn_female_ngochuyen") else "giọng trong danh sách")
        try:
            audio = await tts.synth("Xin chào.", code, 1.0)
            c.assistant.budget.record_tts(len("Xin chào."))
            steps.append({"name": f"Đọc thử bằng {label}", "ok": True, "voice": code,
                          "detail": f"Vbee trả về {len(audio.data):,} byte âm thanh.".replace(",", ".")})
            working = working or code
            if code == chosen:
                break
        except TtsError as exc:
            steps.append({"name": f"Đọc thử bằng {label}", "ok": False, "voice": code, "detail": exc.message,
                          "status": exc.status, "raw": exc.raw})
    return {"steps": steps, "working_voice": working, "voices": len(listed)}


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


class AutopilotIn(BaseModel):
    on: bool


@router.post("/ai/autopilot")
async def autopilot(body: AutopilotIn, request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    """One switch on the host desk: read comments and answer them without waiting for the host."""
    c = request.app.state.container
    a = c.assistant
    cfg = a.config
    if body.on:
        if c.settings.tts_locked:
            raise HTTPException(422, detail={"code": "tts_locked", "message": "Giọng đọc đang bị khóa (CHIBI_TTS_LOCKED)."})
        if not cfg.voice_policy_confirmed:
            raise HTTPException(422, detail={"code": "policy_not_confirmed",
                                             "message": "Vào Trợ lý AI & giọng đọc, đánh dấu danh sách chính sách trước."})
        if c.speech.provider is None:
            raise HTTPException(422, detail={"code": "voice_not_configured", "message": "Chưa nhập App ID/Token Vbee."})
    new = cfg.model_copy(update={"autopilot": body.on, "voice_enabled": cfg.voice_enabled or body.on})
    a.update_config(new)
    if body.on and c.speech.muted:
        c.speech.unmute()
    with c.db.session() as s:
        s.add(AuditLog(admin_id=admin.id, action="autopilot_on" if body.on else "autopilot_off", resource="ai", detail=None))
    status = a.status()
    c.hub.send_dashboard({"type": "AI_STATUS", "ai": status})
    return {"ai": status}
