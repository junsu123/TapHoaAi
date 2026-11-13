"""Evaluate the comment router on a labelled Vietnamese dataset (PRD-03, SPEC G1.4).

    python -m app.eval_matcher tests/fixtures/comments_vi.csv

Safety first: a comment must NEVER move a Chibi to the wrong product. `wrong_product`
must stay 0; recall tells how many product comments are understood."""

from __future__ import annotations

import csv
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

from app.services.intent_router import CommentIntentRouter


@dataclass
class EvalReport:
    total: int = 0
    intent_correct: int = 0
    product_rows: int = 0
    product_hits: int = 0
    wrong_product: int = 0
    false_moves: int = 0
    confusion: Counter = field(default_factory=Counter)
    misses: list[tuple[str, str, str]] = field(default_factory=list)

    @property
    def intent_accuracy(self) -> float:
        return self.intent_correct / self.total if self.total else 0.0

    @property
    def product_recall(self) -> float:
        return self.product_hits / self.product_rows if self.product_rows else 0.0

    def as_text(self) -> str:
        lines = [
            f"Bình luận: {self.total}",
            f"Đúng loại ý định: {self.intent_correct}/{self.total} = {self.intent_accuracy:.1%}",
            f"Chibi đi đúng sản phẩm (recall): {self.product_hits}/{self.product_rows} = {self.product_recall:.1%}",
            f"Đi SAI sản phẩm: {self.wrong_product}  (phải bằng 0)",
            f"Đi lấy hàng khi không nên: {self.false_moves}",
            "Nhầm lẫn (mong đợi → thực tế):",
        ]
        lines += [f"  {a:9s} → {b:9s}: {n}" for (a, b), n in sorted(self.confusion.items()) if a != b]
        if self.misses:
            lines.append("Chưa đúng:")
            lines += [f"  {t!r}: mong đợi {e}, ra {g}" for t, e, g in self.misses]
        return "\n".join(lines)


def evaluate(router: CommentIntentRouter, rows: list[dict[str, str]]) -> EvalReport:
    rep = EvalReport()
    for row in rows:
        text, want_intent, want_product = row["text"], row["intent"], (row.get("product") or None)
        got = router.route(text)
        rep.total += 1
        rep.confusion[(want_intent, got.kind.value)] += 1
        if got.kind.value == want_intent:
            rep.intent_correct += 1
        moved = got.product_id if got.moves_chibi else None
        if want_product:
            rep.product_rows += 1
            if moved == want_product:
                rep.product_hits += 1
        if moved and want_product and moved != want_product:
            rep.wrong_product += 1
        if moved and not want_product:
            rep.false_moves += 1
        if got.kind.value != want_intent or moved != want_product:
            rep.misses.append((text, f"{want_intent}/{want_product}", f"{got.kind.value}/{moved}"))
    return rep


def load_rows(path: Path) -> list[dict[str, str]]:
    with open(path, encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


if __name__ == "__main__":  # pragma: no cover - CLI
    from app.config import get_settings
    from app.db import Database
    from app.services.catalog import build_catalog
    from app.services.product_matcher import ProductMatcher

    s = get_settings()
    cat = build_catalog(Database(s.resolved_database_url), 1)
    r = CommentIntentRouter(ProductMatcher(cat, s.match_high_confidence, s.match_suggest_floor, s.match_ambiguity_margin))
    print(evaluate(r, load_rows(Path(sys.argv[1] if len(sys.argv) > 1 else "tests/fixtures/comments_vi.csv"))).as_text())
