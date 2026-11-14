"""Conversation log of the LIVE sessions and the answer memory learned from it."""

from __future__ import annotations

import csv
import io
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import selectinload

from app.models import AuditLog, ConversationTurn, KnowledgeEntry, LiveSessionRow
from app.security.sessions import AdminDep, CurrentAdmin
from app.services.answer_memory import product_words, tokens

router = APIRouter(tags=["conversations"])


def _turn(t: ConversationTurn) -> dict:
    return {"id": t.id, "event_id": t.event_id, "session_id": t.session_id, "is_demo": t.is_demo,
            "asked_at": t.asked_at.isoformat() if t.asked_at else None, "nickname": t.nickname,
            "question": t.question, "intent": t.intent, "product_id": t.product_id, "draft": t.draft,
            "draft_source": t.draft_source, "answer": t.answer, "answered_by": t.answered_by, "status": t.status,
            "spoken": t.spoken, "knowledge_id": t.knowledge_id, "cost_usd": t.cost_usd}


def _entry(e: KnowledgeEntry, catalog) -> dict:
    p = catalog.products.get(e.product_id or "")
    return {"id": e.id, "product_id": e.product_id, "product_name": p.name if p else None, "intent": e.intent,
            "answer": e.answer, "enabled": e.enabled, "trusted": e.trusted, "source": e.source, "uses": e.uses,
            "created_at": e.created_at.isoformat() if e.created_at else None,
            "last_used_at": e.last_used_at.isoformat() if e.last_used_at else None,
            "variants": [{"id": v.id, "question": v.question} for v in e.variants]}


# ---------------------------------------------------------------------------- conversation log
@router.get("/conversations/sessions")
def sessions(request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    with c.db.session() as s:
        rows = s.execute(
            select(ConversationTurn.session_id, func.count(ConversationTurn.id), func.min(ConversationTurn.asked_at),
                   func.max(ConversationTurn.asked_at), func.max(ConversationTurn.is_demo))
            .group_by(ConversationTurn.session_id).order_by(func.max(ConversationTurn.asked_at).desc())).all()
        meta = {r.id: r for r in s.execute(select(LiveSessionRow)).scalars()}
        by_source = dict(s.execute(select(ConversationTurn.draft_source, func.count(ConversationTurn.id))
                                   .group_by(ConversationTurn.draft_source)).all())
        out = []
        for sid, n, first, last, demo in rows:
            m = meta.get(sid)
            out.append({"session_id": sid, "questions": n, "first_at": first.isoformat() if first else None,
                        "last_at": last.isoformat() if last else None, "is_demo": bool(demo),
                        "provider": m.provider if m else None, "unique_id": m.unique_id if m else None})
    return {"sessions": out, "by_source": {k or "none": v for k, v in by_source.items()}}


@router.get("/conversations")
def conversations(request: Request, session_id: str | None = None, q: str | None = Query(None, max_length=100),
                  limit: int = Query(200, ge=1, le=1000), offset: int = Query(0, ge=0),
                  admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    stmt = select(ConversationTurn)
    if session_id:
        stmt = stmt.where(ConversationTurn.session_id == session_id)
    if q:
        like = f"%{q}%"
        stmt = stmt.where(or_(ConversationTurn.question.ilike(like), ConversationTurn.answer.ilike(like),
                              ConversationTurn.draft.ilike(like)))
    with c.db.session() as s:
        total = s.execute(select(func.count()).select_from(stmt.subquery())).scalar_one()
        rows = s.execute(stmt.order_by(ConversationTurn.asked_at.desc()).limit(limit).offset(offset)).scalars().all()
        return {"total": total, "items": [_turn(t) for t in rows]}


@router.get("/conversations/stats")
def stats(request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    since = datetime.now(UTC) - timedelta(days=1)
    with c.db.session() as s:
        today = dict(s.execute(select(ConversationTurn.draft_source, func.count(ConversationTurn.id))
                               .where(ConversationTurn.asked_at >= since).group_by(ConversationTurn.draft_source)).all())
        learned = s.execute(select(func.count(KnowledgeEntry.id)).where(KnowledgeEntry.trusted.is_(True))).scalar_one()
        pending = s.execute(select(func.count(KnowledgeEntry.id)).where(KnowledgeEntry.trusted.is_(False))).scalar_one()
    no_claude = today.get("memory", 0) + today.get("template", 0)
    return {"last_24h": {k or "none": v for k, v in today.items()}, "answered_without_claude_24h": no_claude,
            "claude_calls_24h": today.get("claude", 0), "learned": learned, "pending_review": pending}


@router.get("/conversations/export.csv")
def export_csv(request: Request, session_id: str | None = None, admin: CurrentAdmin = AdminDep) -> Response:
    c = request.app.state.container
    stmt = select(ConversationTurn).order_by(ConversationTurn.asked_at)
    if session_id:
        stmt = stmt.where(ConversationTurn.session_id == session_id)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Thời gian", "Phiên", "Demo", "Khách", "Câu hỏi", "Sản phẩm", "Gợi ý", "Nguồn gợi ý",
                "Câu trả lời", "Ai trả lời", "Trạng thái", "Đã đọc", "Chi phí USD"])
    with c.db.session() as s:
        for t in s.execute(stmt).scalars():
            w.writerow([t.asked_at.isoformat() if t.asked_at else "", t.session_id or "", "có" if t.is_demo else "",
                        t.nickname or "", t.question, t.product_id or "", t.draft or "", t.draft_source or "",
                        t.answer or "", t.answered_by or "", t.status, "có" if t.spoken else "",
                        f"{t.cost_usd:.6f}"])
    name = f"hoi-thoai-{session_id or 'tat-ca'}.csv".replace("/", "_")
    # utf-8 with BOM so Excel shows Vietnamese correctly
    return Response("﻿" + buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


# ---------------------------------------------------------------------------- answer memory
class KnowledgeIn(BaseModel):
    questions: list[str] = Field(min_length=1, max_length=20)
    product_id: str | None = Field(None, max_length=64)
    answer: str = Field(min_length=2, max_length=280)


class KnowledgePatch(BaseModel):
    answer: str | None = Field(None, min_length=2, max_length=280)
    enabled: bool | None = None
    trusted: bool | None = None
    add_question: str | None = Field(None, min_length=2, max_length=300)


class KnowledgeTest(BaseModel):
    question: str = Field(min_length=1, max_length=300)
    product_id: str | None = Field(None, max_length=64)


@router.get("/knowledge")
def list_knowledge(request: Request, status: str | None = Query(None, pattern="^(trusted|pending|disabled)$"),
                   q: str | None = Query(None, max_length=100), admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    stmt = select(KnowledgeEntry).options(selectinload(KnowledgeEntry.variants))
    if status == "trusted":
        stmt = stmt.where(KnowledgeEntry.trusted.is_(True), KnowledgeEntry.enabled.is_(True))
    elif status == "pending":
        stmt = stmt.where(KnowledgeEntry.trusted.is_(False))
    elif status == "disabled":
        stmt = stmt.where(KnowledgeEntry.enabled.is_(False))
    with c.db.session() as s:
        rows = s.execute(stmt.order_by(KnowledgeEntry.trusted, KnowledgeEntry.uses.desc(), KnowledgeEntry.id.desc())
                         ).scalars().all()
        items = [_entry(e, c.catalog) for e in rows]
    if q:
        ql = q.lower()
        items = [i for i in items if ql in i["answer"].lower() or any(ql in v["question"].lower() for v in i["variants"])]
    return {"items": items}


def _check_product(c, product_id: str | None) -> None:
    if product_id and product_id not in c.catalog.products:
        raise HTTPException(422, detail={"code": "unknown_product", "message": "Sản phẩm không có trong danh mục."})


@router.post("/knowledge", status_code=201)
def add_knowledge(body: KnowledgeIn, request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    _check_product(c, body.product_id)
    if not any(tokens(q, product_words(c.catalog, body.product_id)) for q in body.questions):
        raise HTTPException(422, detail={"code": "empty_question", "message": "Câu hỏi quá ngắn hoặc chỉ toàn từ đệm."})
    kid = c.assistant.memory.add_manual(body.questions, body.product_id, body.answer, c.catalog)
    with c.db.session() as s:
        s.add(AuditLog(admin_id=admin.id, action="knowledge_add", resource=str(kid), detail=None))
        e = s.execute(select(KnowledgeEntry).options(selectinload(KnowledgeEntry.variants))
                      .where(KnowledgeEntry.id == kid)).scalar_one()
        return _entry(e, c.catalog)


@router.patch("/knowledge/{entry_id}")
def patch_knowledge(entry_id: int, body: KnowledgePatch, request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    c = request.app.state.container
    if not c.assistant.memory.update(entry_id, answer=body.answer, enabled=body.enabled, trusted=body.trusted,
                                     add_question=body.add_question, catalog=c.catalog):
        raise HTTPException(404, detail={"code": "not_found", "message": "Không tìm thấy câu đã học."})
    with c.db.session() as s:
        s.add(AuditLog(admin_id=admin.id, action="knowledge_update", resource=str(entry_id),
                       detail=body.model_dump(exclude_none=True)))
        e = s.execute(select(KnowledgeEntry).options(selectinload(KnowledgeEntry.variants))
                      .where(KnowledgeEntry.id == entry_id)).scalar_one()
        return _entry(e, c.catalog)


@router.delete("/knowledge/{entry_id}", status_code=204)
def delete_knowledge(entry_id: int, request: Request, admin: CurrentAdmin = AdminDep) -> Response:
    c = request.app.state.container
    if not c.assistant.memory.delete(entry_id):
        raise HTTPException(404, detail={"code": "not_found", "message": "Không tìm thấy câu đã học."})
    with c.db.session() as s:
        s.add(AuditLog(admin_id=admin.id, action="knowledge_delete", resource=str(entry_id), detail=None))
    return Response(status_code=204)


@router.delete("/knowledge/{entry_id}/variants/{variant_id}", status_code=204)
def delete_variant(entry_id: int, variant_id: int, request: Request, admin: CurrentAdmin = AdminDep) -> Response:
    c = request.app.state.container
    if not c.assistant.memory.delete_variant(entry_id, variant_id):
        raise HTTPException(404, detail={"code": "not_found", "message": "Không tìm thấy câu hỏi này."})
    return Response(status_code=204)


@router.post("/knowledge/test")
def test_knowledge(body: KnowledgeTest, request: Request, admin: CurrentAdmin = AdminDep) -> dict:
    """What would the LIVE answer to this question without Claude?"""
    c = request.app.state.container
    _check_product(c, body.product_id)
    cfg = c.assistant.config
    product_id = body.product_id
    if product_id is None:
        product_id = c.router.route(body.question).product_id
    hit = c.assistant.memory.best(body.question, product_id, c.catalog, trusted_only=True)
    if hit is None:
        return {"matched": False, "product_id": product_id, "threshold": cfg.memory_threshold}
    entry, score, wording = hit
    return {"matched": score >= cfg.memory_threshold, "score": round(score, 3), "threshold": cfg.memory_threshold,
            "product_id": product_id, "entry_id": entry.id, "matched_question": wording,
            "answer": c.assistant.memory.render(entry, c.catalog)}
