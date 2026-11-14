"""Answer memory: the shop's confirmed answers, reused for similar questions without Claude.

Every answer a person confirmed on the host desk is remembered together with the wording of the
question. A new question about the same product (or a general question, product None) whose
wording is close enough — same words after Vietnamese folding, chat abbreviations ("bn", "ko",
"sp"…) expanded, filler words ("shop ơi", "ạ", "nha"…) and the product's own name removed — gets
that answer at once. The product's price is stored as {gia} and filled with today's verified
price, so a price change never makes the shop say an old price; if the product has no verified
price any more, or the answer would fail the safety checks, the memory is not used.

Answers Claude gave on its own (auto mode) are remembered as "chờ duyệt" (not trusted) and are
not reused until a person confirms them in the dashboard."""

from __future__ import annotations

import itertools
import threading
import unicodedata
from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.db import Database
from app.models import KnowledgeEntry, KnowledgeVariant
from app.services.catalog import Catalog
from app.services.text_safety import (
    _PRICE,
    _amount,
    format_vnd,
    risky_claims,
    unknown_prices,
)
from app.text_norm import fold, strip_diacritics

SYNONYMS = {
    "bn": "bao nhieu", "bnh": "bao nhieu", "bnhieu": "bao nhieu", "baonhieu": "bao nhieu", "nhiu": "nhieu",
    "ko": "khong", "k": "khong", "kg": "khong", "hok": "khong", "hong": "khong", "khum": "khong", "kh": "khong",
    "khg": "khong", "hem": "khong", "sp": "san pham", "dc": "duoc", "dk": "duoc", "j": "gi", "z": "vay",
    "v": "vay", "ntn": "thenao", "ad": "shop", "sop": "shop", "s": "shop",
    "ship": "giao", "gui": "giao", "freeship": "mien phi giao", "hsd": "han su dung", "bh": "bao gio", "tien": "gia", "mua": "dat", "order": "dat", "oder": "dat", "cod": "cod",
}
FILLERS = {
    "shop", "oi", "a", "ah", "ak", "nha", "nhe", "nhi", "vay", "the", "ho", "ne", "voi", "di", "luon",
    "em", "chi", "anh", "ban", "minh", "cho", "hoi", "xin", "giup", "dum", "cai", "nay", "kia",
    "la", "thi", "ma", "hen", "hihi", "haha", "lun", "nua", "hem", "u", "uh",
}
NO_LEARN_INTENTS = {"STOCK", "OFF_TOPIC"}
TIME_SENSITIVE = ("hom nay", "bay gio", "con hang", "het hang", "chi con", "khuyen mai", "giam gia", "flash sale",
                  "tang kem", "qua tang", "sap het")
DEFAULT_THRESHOLD = 0.75


# phrases that mean the same thing, folded (applied after SYNONYMS, before fillers are dropped)
PHRASES = (("nhu the nao", "thenao"), ("the nao", "thenao"), ("ra sao", "thenao"), ("bao nhieu tien", "bao nhieu"),
           ("gia ca", "gia"), ("co duoc khong", "duoc khong"), ("duoc ko", "duoc khong"))


def tokens(text: str, drop: set[str] | None = None) -> list[str]:
    words: list[str] = []
    for w in fold(text).split():
        words.extend(SYNONYMS.get(w, w).split())
    joined = f" {' '.join(words)} "
    for a, b in PHRASES:
        joined = joined.replace(f" {a} ", f" {b} ")
    words = joined.split()
    drop = drop or set()
    return [w for w in words if w not in FILLERS and w not in drop]


def similarity(a: list[str], b: list[str]) -> float:
    """Dice coefficient over words and word pairs (word order counts a little)."""
    if not a or not b:
        return 0.0
    fa = set(a) | {f"{x} {y}" for x, y in itertools.pairwise(a)}
    fb = set(b) | {f"{x} {y}" for x, y in itertools.pairwise(b)}
    return 2 * len(fa & fb) / (len(fa) + len(fb))


def product_words(catalog: Catalog, product_id: str | None) -> set[str]:
    if not product_id:
        return set()
    out: set[str] = set()
    p = catalog.products.get(product_id)
    if p:
        out |= set(fold(p.name).split())
    for a in catalog.aliases:
        if a.product_id == product_id and not a.is_generic:
            out |= set(a.normalized.split())
    return out - {"gia", "bao", "nhieu", "khong", "uong", "dung", "giao"}


def to_template(answer: str, price: int | None) -> str:
    """Replace the product's current price in the answer by {gia}."""
    if not price:
        return answer
    answer = unicodedata.normalize("NFC", answer)
    low = strip_diacritics(answer.lower())
    if len(low) != len(answer):  # spans would not line up: keep the literal text
        return answer
    out, last = [], 0
    for m in _PRICE.finditer(low):
        if _amount(m.group(1), m.group(2)) == price:
            out.append(answer[last:m.start()])
            out.append("{gia}")
            last = m.end()
    out.append(answer[last:])
    return "".join(out)


@dataclass
class Entry:
    id: int
    product_id: str | None
    intent: str | None
    answer: str
    enabled: bool
    trusted: bool
    source: str
    uses: int
    variants: list[tuple[int, str, list[str]]] = field(default_factory=list)  # (id, question, tokens)


@dataclass
class Match:
    entry: Entry
    score: float
    question: str  # the remembered wording that matched
    answer: str  # ready to say (price filled in)


class AnswerMemory:
    def __init__(self, db: Database):
        self.db = db
        self.entries: dict[int, Entry] = {}
        self._lock = threading.Lock()
        self._catalog: Catalog | None = None

    # ------------------------------------------------------------------ loading
    def load(self, catalog: Catalog) -> None:
        self._catalog = catalog
        with self.db.session() as s:
            rows = s.execute(select(KnowledgeEntry).options(selectinload(KnowledgeEntry.variants))).scalars().all()
            entries = {r.id: self._entry(r, catalog) for r in rows}
        with self._lock:
            self.entries = entries

    def _entry(self, r: KnowledgeEntry, catalog: Catalog) -> Entry:
        drop = product_words(catalog, r.product_id)
        return Entry(r.id, r.product_id, r.intent, r.answer, r.enabled, r.trusted, r.source, r.uses,
                     [(v.id, v.question, tokens(v.question, drop)) for v in r.variants])

    def _reload_one(self, entry_id: int) -> None:
        catalog = self._catalog
        with self.db.session() as s:
            r = s.execute(select(KnowledgeEntry).options(selectinload(KnowledgeEntry.variants))
                          .where(KnowledgeEntry.id == entry_id)).scalar_one_or_none()
            e = self._entry(r, catalog) if r and catalog else None
        with self._lock:
            if e is None:
                self.entries.pop(entry_id, None)
            else:
                self.entries[entry_id] = e

    # ------------------------------------------------------------------ matching
    def best(self, question: str, product_id: str | None, catalog: Catalog, *, trusted_only: bool,
             enabled_only: bool = True) -> tuple[Entry, float, str] | None:
        q = tokens(question, product_words(catalog, product_id))
        best: tuple[Entry, float, str] | None = None
        with self._lock:
            candidates = [e for e in self.entries.values() if e.product_id == product_id
                          and (e.enabled or not enabled_only) and (e.trusted or not trusted_only)]
        for e in candidates:
            for _, wording, vt in e.variants:
                sc = 1.0 if vt == q and q else similarity(q, vt)
                if best is None or sc > best[1]:
                    best = (e, sc, wording)
        return best

    def render(self, entry: Entry, catalog: Catalog) -> str | None:
        """The answer with today's price, or None when it may not be said any more."""
        text = entry.answer
        if "{gia}" in text:
            p = catalog.products.get(entry.product_id or "")
            if p is None or not p.display_price:
                return None
            text = text.replace("{gia}", format_vnd(p.display_price))
        if entry.product_id and entry.product_id not in catalog.products:
            return None
        allowed = " ".join(f"{p.claim_text or ''} {p.disclaimer or ''}" for p in catalog.products.values())
        if [c for c in risky_claims(text) if c not in risky_claims(allowed)]:
            return None
        prices = {p.display_price for p in catalog.products.values() if p.display_price}
        if unknown_prices(text, prices):
            return None
        return text

    def match(self, question: str, product_id: str | None, catalog: Catalog, threshold: float) -> Match | None:
        hit = self.best(question, product_id, catalog, trusted_only=True)
        if hit is None or hit[1] < threshold:
            return None
        answer = self.render(hit[0], catalog)
        return Match(hit[0], hit[1], hit[2], answer) if answer else None

    def mark_used(self, entry_id: int) -> None:
        with self.db.session() as s:
            r = s.get(KnowledgeEntry, entry_id)
            if r:
                r.uses += 1
                r.last_used_at = datetime.now(UTC)
        with self._lock:
            if entry_id in self.entries:
                self.entries[entry_id].uses += 1

    # ------------------------------------------------------------------ learning
    def learn(self, question: str, product_id: str | None, intent: str | None, answer: str, *, trusted: bool,
              source: str, catalog: Catalog, threshold: float) -> int | None:
        """Remember (question → answer). Returns the entry id, or None when it must not be learned."""
        answer = " ".join(answer.split())
        if not answer or not question.strip() or (intent or "") in NO_LEARN_INTENTS:
            return None
        if any(w in f" {fold(answer)} " for w in (f" {t} " for t in TIME_SENSITIVE)):
            trusted = False  # promotions/stock change: keep it for review only
        p = catalog.products.get(product_id or "")
        template = to_template(answer, p.display_price if p else None)
        norm = " ".join(tokens(question, product_words(catalog, product_id)))
        if not norm:
            return None
        hit = self.best(question, product_id, catalog, trusted_only=False, enabled_only=False)
        with self.db.session() as s:
            row: KnowledgeEntry | None = None
            if hit and hit[1] >= threshold:
                row = s.get(KnowledgeEntry, hit[0].id)
            if row is not None and (row.answer == template or trusted or not row.trusted):
                # same question again: a person's newest wording wins; an unconfirmed one never
                # replaces a confirmed answer
                if trusted or not row.trusted:
                    row.answer = template
                row.trusted = row.trusted or trusted
                if trusted and row.source == "auto":
                    row.source = source
            else:
                row = KnowledgeEntry(product_id=product_id, intent=intent, answer=template, enabled=True,
                                     trusted=trusted, source=source, uses=0)
                s.add(row)
                s.flush()
            if norm not in {v.normalized for v in row.variants}:
                row.variants.append(KnowledgeVariant(question=question[:300], normalized=norm))
            s.flush()
            entry_id = row.id
        self._reload_one(entry_id)
        return entry_id

    # ------------------------------------------------------------------ dashboard edits
    def add_manual(self, questions: list[str], product_id: str | None, answer: str, catalog: Catalog) -> int:
        p = catalog.products.get(product_id or "")
        drop = product_words(catalog, product_id)
        with self.db.session() as s:
            row = KnowledgeEntry(product_id=product_id, intent=None,
                                 answer=to_template(" ".join(answer.split()), p.display_price if p else None),
                                 enabled=True, trusted=True, source="manual", uses=0)
            for q in questions:
                norm = " ".join(tokens(q, drop))
                if norm and norm not in {v.normalized for v in row.variants}:
                    row.variants.append(KnowledgeVariant(question=q.strip()[:300], normalized=norm))
            s.add(row)
            s.flush()
            entry_id = row.id
        self._reload_one(entry_id)
        return entry_id

    def update(self, entry_id: int, *, answer: str | None = None, enabled: bool | None = None,
               trusted: bool | None = None, add_question: str | None = None, catalog: Catalog) -> bool:
        with self.db.session() as s:
            row = s.get(KnowledgeEntry, entry_id)
            if row is None:
                return False
            p = catalog.products.get(row.product_id or "")
            if answer is not None:
                row.answer = to_template(" ".join(answer.split()), p.display_price if p else None)
                row.trusted = True  # edited by a person
            if enabled is not None:
                row.enabled = enabled
            if trusted is not None:
                row.trusted = trusted
            if add_question:
                norm = " ".join(tokens(add_question, product_words(catalog, row.product_id)))
                if norm and norm not in {v.normalized for v in row.variants}:
                    row.variants.append(KnowledgeVariant(question=add_question.strip()[:300], normalized=norm))
        self._reload_one(entry_id)
        return True

    def delete(self, entry_id: int) -> bool:
        with self.db.session() as s:
            row = s.get(KnowledgeEntry, entry_id)
            if row is None:
                return False
            s.delete(row)
        self._reload_one(entry_id)
        return True

    def delete_variant(self, entry_id: int, variant_id: int) -> bool:
        with self.db.session() as s:
            v = s.get(KnowledgeVariant, variant_id)
            if v is None or v.entry_id != entry_id:
                return False
            s.delete(v)
        self._reload_one(entry_id)
        return True

