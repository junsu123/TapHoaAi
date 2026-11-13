"""Matcher quality on the labelled Vietnamese dataset (PRD-03).

The dataset was written by the developer (synthetic, not real livestream logs) and the
rules were tuned on it — so these numbers are an upper bound. Replace/extend it with real,
anonymised comments before trusting the thresholds (see docs/acceptance-report.md)."""

from pathlib import Path

from app.eval_matcher import evaluate, load_rows
from app.services.intent_router import CommentIntentRouter
from app.services.product_matcher import ProductMatcher

DATA = Path(__file__).parent / "fixtures" / "comments_vi.csv"


def test_dataset_safety_and_recall(catalog):
    rep = evaluate(CommentIntentRouter(ProductMatcher(catalog)), load_rows(DATA))
    print("\n" + rep.as_text())
    assert rep.total >= 100
    assert rep.wrong_product == 0, rep.as_text()  # never walk to the wrong product
    assert rep.false_moves == 0, rep.as_text()
    assert rep.product_recall >= 0.95, rep.as_text()
    assert rep.intent_accuracy >= 0.90, rep.as_text()
