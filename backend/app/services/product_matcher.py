"""Comment -> product matching (PRD-03, SPEC G1 steps 3-4).

Tiers, first hit wins:
  1. exact alias            score 1.00
  2. alias phrase contained score 0.95 (longest alias wins)
  3. fuzzy (short comments) score = normalised edit similarity, or 0.90 when the
     comment is a >=2-token subset covering >=60% of a multi-token alias
Never guesses: generic aliases ("trà"), several products tied, or a score below the
high-confidence threshold all yield AMBIGUOUS for the host to resolve (C2)."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum

from rapidfuzz import fuzz

from app.services.catalog import AliasEntry, Catalog
from app.text_norm import normalize_vi


class MatchStatus(StrEnum):
    MATCH = "MATCH"
    AMBIGUOUS = "AMBIGUOUS"
    NONE = "NONE"


@dataclass
class MatchResult:
    status: MatchStatus
    product_id: str | None = None
    confidence: float = 0.0
    tier: str | None = None
    candidates: list[tuple[str, float]] = field(default_factory=list)
    normalized: str = ""


class ProductMatcher:
    def __init__(self, catalog: Catalog, high: float = 0.90, floor: float = 0.75,
                 margin: float = 0.05, max_fuzzy_tokens: int = 8):
        self.catalog = catalog
        self.high = high
        self.floor = floor
        self.margin = margin
        self.max_fuzzy_tokens = max_fuzzy_tokens

    def _best_per_product(self, scored: list[tuple[AliasEntry, float]]) -> list[tuple[str, float]]:
        best: dict[str, float] = {}
        for a, sc in scored:
            if sc > best.get(a.product_id, -1):
                best[a.product_id] = sc
        return sorted(best.items(), key=lambda kv: (-kv[1], kv[0]))

    def match(self, text: str) -> MatchResult:
        q = normalize_vi(text)
        if not q:
            return MatchResult(MatchStatus.NONE, normalized=q)
        aliases = self.catalog.aliases

        # Tier 1 — exact alias
        exact = [a for a in aliases if a.normalized == q]
        if exact:
            pids = sorted({a.product_id for a in exact})
            if len(pids) == 1 and not any(a.is_generic for a in exact):
                return MatchResult(MatchStatus.MATCH, pids[0], 1.0, "exact", [(pids[0], 1.0)], q)
            return MatchResult(MatchStatus.AMBIGUOUS, None, 1.0, "exact", [(p, 1.0) for p in pids], q)

        # Tier 2 — alias phrase contained in the comment (word boundaries)
        padded = f" {q} "
        contained = [a for a in aliases if f" {a.normalized} " in padded]
        if contained:
            specific = [a for a in contained if not a.is_generic]
            if specific:
                longest = max(len(a.normalized) for a in specific)
                top = [a for a in specific if len(a.normalized) == longest]
                pids = sorted({a.product_id for a in top})
                others = sorted({a.product_id for a in specific} - set(pids))
                # a different product also named explicitly → ambiguous
                if len(pids) == 1 and not others:
                    return MatchResult(MatchStatus.MATCH, pids[0], 0.95, "contains", [(pids[0], 0.95)], q)
                cands = [(p, 0.95) for p in pids] + [(p, 0.9) for p in others]
                return MatchResult(MatchStatus.AMBIGUOUS, None, 0.95, "contains", cands, q)
        generic_pids = sorted({a.product_id for a in contained})
        generic_result = (
            MatchResult(MatchStatus.AMBIGUOUS, None, 0.5, "generic", [(p, 0.5) for p in generic_pids], q)
            if generic_pids else None
        )

        # Tier 3 — fuzzy, only for short comments ("tra ca gai leeo" still reaches here
        # because only the generic alias "tra" was contained)
        q_tokens = q.split()
        if len(q_tokens) > self.max_fuzzy_tokens:
            return generic_result or MatchResult(MatchStatus.NONE, normalized=q)
        scored: list[tuple[AliasEntry, float]] = []
        q_set = set(q_tokens)
        for a in aliases:
            if a.is_generic or a.tokens < 2:
                continue
            sc = fuzz.ratio(q, a.normalized) / 100.0
            a_tokens = a.normalized.split()
            if len(q_tokens) >= 2 and q_set <= set(a_tokens) and len(q_set) / len(set(a_tokens)) >= 0.6:
                sc = max(sc, 0.90)
            scored.append((a, sc))
        ranked = self._best_per_product(scored)
        if not ranked or ranked[0][1] < self.floor:
            return generic_result or MatchResult(MatchStatus.NONE, normalized=q, candidates=ranked[:3])
        top_pid, top_score = ranked[0]
        tied = len(ranked) > 1 and top_score - ranked[1][1] < self.margin and ranked[1][1] >= self.floor
        if top_score >= self.high and not tied:
            return MatchResult(MatchStatus.MATCH, top_pid, round(top_score, 3), "fuzzy", ranked[:3], q)
        return MatchResult(MatchStatus.AMBIGUOUS, None, round(top_score, 3), "fuzzy", ranked[:3], q)
