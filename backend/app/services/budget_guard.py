"""BudgetGuard (AI-05): USD per day and per month for Claude, characters per month for TTS.

Usage is kept in `daily_usage` (one row per day and model; TTS rows use model "tts:vbee" and count
characters in input_tokens). Before a Claude call the worst case (prompt estimate + max output
tokens) must fit in what is left; after it the real usage is recorded. Alerts fire once per
period when spending crosses 70 %, 90 % and 100 % (PRD J)."""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, date, datetime
from typing import Any

from sqlalchemy import func, select

from app.db import Database
from app.models import DailyUsage
from app.services.ai_config import price_of

TTS_MODEL = "tts:vbee"
THRESHOLDS = ((1.0, "AI_BUDGET_EXHAUSTED"), (0.9, "AI_SPEND_90_PERCENT"), (0.7, "AI_SPEND_70_PERCENT"))


def today() -> date:
    return datetime.now(UTC).date()


def cost_usd(model: str, tokens_in: int, tokens_out: int) -> float:
    pin, pout = price_of(model)
    return tokens_in * pin / 1e6 + tokens_out * pout / 1e6


class BudgetGuard:
    def __init__(self, db: Database, alert: Callable[[str, dict[str, Any]], None] = lambda code, info: None):
        self.db = db
        self.alert = alert
        self._fired: set[tuple[str, str]] = set()

    # ------------------------------------------------------------------ reading
    def spent(self, day: date | None = None) -> tuple[float, float]:
        d = day or today()
        month_start = d.replace(day=1)
        with self.db.session() as s:
            q = select(func.coalesce(func.sum(DailyUsage.estimated_usd), 0.0)).where(DailyUsage.model != TTS_MODEL)
            day_usd = s.execute(q.where(DailyUsage.day == d)).scalar_one()
            month_usd = s.execute(q.where(DailyUsage.day >= month_start, DailyUsage.day <= d)).scalar_one()
        return float(day_usd), float(month_usd)

    def tts_chars_this_month(self) -> int:
        d = today()
        with self.db.session() as s:
            return int(s.execute(select(func.coalesce(func.sum(DailyUsage.input_tokens), 0)).where(
                DailyUsage.model == TTS_MODEL, DailyUsage.day >= d.replace(day=1))).scalar_one())

    def status(self, day_cap: float, month_cap: float, tts_cap: int) -> dict[str, Any]:
        day_usd, month_usd = self.spent()
        return {"day_usd": round(day_usd, 5), "month_usd": round(month_usd, 5), "day_cap": day_cap,
                "month_cap": month_cap, "exhausted": not self.allows(0.0, day_cap, month_cap),
                "tts_chars_month": self.tts_chars_this_month(), "tts_chars_cap": tts_cap}

    # ------------------------------------------------------------------ deciding
    def allows(self, worst_case_usd: float, day_cap: float, month_cap: float) -> bool:
        day_usd, month_usd = self.spent()
        return day_usd + worst_case_usd <= day_cap and month_usd + worst_case_usd <= month_cap and \
            day_cap > 0 and month_cap > 0

    def worst_case(self, model: str, prompt_chars: int, max_output_tokens: int) -> float:
        # Vietnamese text runs about 2–3 characters per token; count 2 to stay on the safe side
        return cost_usd(model, prompt_chars // 2 + 50, max_output_tokens)

    def tts_allows(self, chars: int, cap: int) -> bool:
        return cap > 0 and self.tts_chars_this_month() + chars <= cap

    # ------------------------------------------------------------------ recording
    def _add(self, model: str, calls: int, tin: int, tout: int, usd: float) -> None:
        d = today()
        with self.db.session() as s:
            row = s.get(DailyUsage, (d, model))
            if row is None:
                row = DailyUsage(day=d, model=model, calls=0, input_tokens=0, output_tokens=0, estimated_usd=0.0)
                s.add(row)
            row.calls += calls
            row.input_tokens += tin
            row.output_tokens += tout
            row.estimated_usd += usd

    def record(self, model: str, tokens_in: int, tokens_out: int, day_cap: float, month_cap: float) -> float:
        usd = cost_usd(model, tokens_in, tokens_out)
        self._add(model, 1, tokens_in, tokens_out, usd)
        self._check_alerts(day_cap, month_cap)
        return usd

    def record_tts(self, chars: int) -> None:
        self._add(TTS_MODEL, 1, chars, 0, 0.0)

    def _check_alerts(self, day_cap: float, month_cap: float) -> None:
        day_usd, month_usd = self.spent()
        d = today()
        for period, spent, cap, key in (("ngày", day_usd, day_cap, d.isoformat()),
                                         ("tháng", month_usd, month_cap, d.strftime("%Y-%m"))):
            if cap <= 0:
                continue
            for ratio, code in THRESHOLDS:
                if spent >= cap * ratio:
                    if (code, f"{period}:{key}") not in self._fired:
                        self._fired.add((code, f"{period}:{key}"))
                        self.alert(code, {"period": period, "spent_usd": round(spent, 4), "cap_usd": cap})
                    break
