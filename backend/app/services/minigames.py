"""Mini-games: a short round every 15–20 minutes (random) to keep viewers on the LIVE.

Three kinds:
  price    — "Đoán giá": a product from the catalog; viewers comment a number ("85", "85k",
             "85.000", "85 nghìn"); the closest guess wins (the earliest on a tie).
  quiz     — "Đố vui": a question with 3 answers (built-in about tea / Vietnam / this LIVE, plus the
             shop's own); viewers comment A, B or C; the first 3 right answers win.
  keyword  — "Nhanh tay": the owner shows a word; the first 3 viewers to comment it win.

One answer per viewer per round (the first counts). An answer is only an answer — it is not read
aloud, does not move a Chibi and does not go to Claude. A round: intro (5 s) → open (answers,
countdown) → reveal (10 s). Winners: a medal on their Chibi, the "Mini-game" tab of the honour
board, a cheer; the owner announces it all (bubble, and the voice when it is on).

Prizes stay inside the game (medals, the board): a real prize or a lucky draw must follow TikTok's
rules for promotions — that is up to the shop.
"""

from __future__ import annotations

import random
import re
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from app.services.text_safety import speakable_name
from app.text_norm import fold

if TYPE_CHECKING:
    from app.container import AppContainer
    from app.events.schema import EventUser

KINDS = ("price", "quiz", "keyword")
TITLES = {"price": "Đoán giá", "quiz": "Đố vui", "keyword": "Nhanh tay"}
INTRO_S = 5.0
REVEAL_S = 10.0
KEYWORD_S = 25.0
WINNERS = 3
STATE_GAP_S = 1.0  # answer counts on the screen: at most once a second

# (question, [right answer, wrong, wrong]) — about tea, Vietnam and this LIVE; never health claims
QUIZ: tuple[tuple[str, tuple[str, str, str]], ...] = (
    ("Vùng nào nổi tiếng với chè xanh ngon bậc nhất miền Bắc?", ("Thái Nguyên", "Cà Mau", "Bến Tre")),
    ("Ở miền Bắc, người ta hay gọi trà là gì?", ("Chè", "Cà phê", "Nước mía")),
    ("Pha trà xanh, nước nên nóng khoảng bao nhiêu độ?", ("70 đến 80 độ", "30 độ", "Nước đá")),
    ("Trà sen Hà Nội được ướp bằng hoa gì?", ("Hoa sen", "Hoa hồng", "Hoa cúc")),
    ("Ngoài sen, hoa nào hay được dùng để ướp trà?", ("Hoa nhài", "Hoa giấy", "Hoa xương rồng")),
    ("Matcha là bột trà xanh nổi tiếng của nước nào?", ("Nhật Bản", "Pháp", "Mexico")),
    ("Trà sữa trân châu bắt nguồn từ đâu?", ("Đài Loan", "Ý", "Nga")),
    ("Nước nào nổi tiếng với thói quen uống trà chiều?", ("Anh", "Brazil", "Úc")),
    ("Lá trà còn lại sau khi pha xong gọi là gì?", ("Bã trà", "Cám", "Rơm")),
    ("Tết Trung thu, người ta hay uống trà cùng món gì?", ("Bánh trung thu", "Kem que", "Bỏng ngô")),
    ("Ngày Tết, ấm trà mời khách thường đi cùng món gì?", ("Mứt Tết", "Pizza", "Khoai tây chiên")),
    ("Cây chè có tên khoa học là gì?", ("Camellia sinensis", "Coffea arabica", "Theobroma cacao")),
    ("Trà đen khác trà xanh ở điểm nào?", ("Lá được ủ lâu hơn", "Hái từ cây ớt", "Pha bằng nước lạnh")),
    ("Trà Shan tuyết mọc ở đâu?", ("Núi cao phía Bắc", "Bãi biển", "Sa mạc")),
    ("Bộ đồ pha trà truyền thống gồm những gì?", ("Ấm và chén", "Nồi và chảo", "Thìa và dĩa")),
    ("Bình luận chữ gì để lên sân khấu nhảy?", ("Nhảy", "Ngủ", "Về")),
    ("Bình luận chữ gì để chủ quán tặng một bài thơ?", ("Làm thơ", "Ăn cơm", "Tắt đèn")),
)

KEYWORDS = ("TRÀ NGON", "CHIBI", "SÂN KHẤU", "NÓN LÁ", "VƯƠNG MIỆN", "CHÉN TRÀ", "ẤM TRÀ", "THẢ TIM", "CHỦ QUÁN")

_NUM = re.compile(r"(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)\s*(k|nghin|ngan|tr|trieu|d|dong|vnd)?\b")


def parse_price(text: str) -> int | None:
    """'85' / '85k' / '85.000' / '85 nghìn' / '1tr2' → VND. Small numbers mean thousands."""
    t = fold(text)
    m = re.search(r"(\d+)\s*(tr|trieu)\s*(\d)?\b", t)
    if m:  # 1tr2 = 1,200,000
        return int(m.group(1)) * 1_000_000 + (int(m.group(3)) * 100_000 if m.group(3) else 0)
    m = _NUM.search(t)
    if not m:
        return None
    raw, unit = m.group(1), m.group(2)
    if re.fullmatch(r"\d{1,3}(?:[.,]\d{3})+", raw):
        value = float(raw.replace(".", "").replace(",", ""))
    else:
        value = float(raw.replace(",", "."))
    if unit in ("k", "nghin", "ngan"):
        value *= 1000
    elif value < 1000:
        value *= 1000  # "85" = 85 nghìn
    v = round(value)
    return v if 0 < v < 100_000_000 else None


def parse_choice(text: str) -> int | None:
    """'A' / 'b' / 'đáp án C' / 'chọn a' → 0/1/2."""
    t = fold(text).strip(" .!?")
    m = re.fullmatch(r"(?:(?:dap an|chon|cau|la)\s+)?([abc])", t)
    return "abc".index(m.group(1)) if m else None


def vnd(v: int) -> str:
    return f"{v:,}".replace(",", ".") + " đồng"


@dataclass
class Answer:
    key: str
    name: str
    at: float
    value: Any
    avatar_id: str | None


@dataclass
class Round:
    id: str
    kind: str
    phase: str  # intro | open | reveal
    started: float  # wall clock
    opens_at: float
    closes_at: float
    ends_at: float
    data: dict[str, Any]
    answers: dict[str, Answer] = field(default_factory=dict)
    winners: list[dict[str, Any]] = field(default_factory=list)
    manual: bool = False


class MiniGames:
    def __init__(self, c: AppContainer, clock=time.time, rng: random.Random | None = None):
        self.c = c
        self.clock = clock
        self.rng = rng or random.Random()
        self.round: Round | None = None
        self.next_at: float | None = None  # wall clock of the next automatic round
        self.history: list[dict[str, Any]] = []
        self.medals: dict[str, int] = {}  # viewer key → wins this LIVE
        self._n = 0
        self._sent = 0.0
        self._dirty = False
        self._recent_quiz: list[str] = []

    @property
    def cfg(self):
        return self.c.scene

    @property
    def active(self) -> bool:
        """Answers are taken (from the intro on: the question is already on the screen)."""
        return self.round is not None and self.round.phase in ("intro", "open")

    def reset(self) -> None:
        self.round = None
        self.next_at = None
        self.medals.clear()
        self.publish()

    def medals_of(self, key: str | None) -> int:
        return self.medals.get(key, 0) if key else 0

    # ------------------------------------------------------------------ rounds
    def kinds_available(self) -> list[str]:
        out = []
        for k in self.cfg.minigame_kinds:
            if k == "price" and not self._priced():
                continue
            out.append(k)
        return out

    def _priced(self) -> list[Any]:
        return [p for p in self.c.catalog.products.values() if p.display_price]

    def start(self, kind: str | None = None, manual: bool = False) -> Round | None:
        if self.round is not None or not self.c.live.session_id:
            return None
        kinds = self.kinds_available()
        if kind is None:
            if not kinds:
                return None
            last = self.history[-1]["kind"] if self.history else None
            kind = self.rng.choice([k for k in kinds if k != last] or kinds)
        if kind not in KINDS or (kind == "price" and not self._priced()):
            return None
        data = self._make(kind)
        if data is None:
            return None
        now = self.clock()
        open_s = KEYWORD_S if kind == "keyword" else float(self.cfg.minigame_seconds)
        self._n += 1
        self.round = Round(id=f"g{self._n}", kind=kind, phase="intro", started=now, opens_at=now + INTRO_S,
                           closes_at=now + INTRO_S + open_s, ends_at=now + INTRO_S + open_s + REVEAL_S,
                           data=data, manual=manual)
        self.next_at = None
        self._say(self._intro_text(self.round), bubble=self._intro_bubble(self.round))
        self.publish()
        return self.round

    def stop(self) -> bool:
        if self.round is None:
            return False
        self.round = None
        self._schedule()
        self.publish()
        return True

    def _make(self, kind: str) -> dict[str, Any] | None:
        if kind == "price":
            p = self.rng.choice(self._priced())
            return {"product_id": p.id, "product": p.name, "price": int(p.display_price),
                    "image": p.card_image_url or p.image_url}
        if kind == "quiz":
            bank = list(QUIZ) + [(q.question, tuple(q.options)) for q in self.cfg.minigame_questions]
            a = self.cfg.level_minutes[0]
            if self.cfg.levels_enabled:
                bank.append(("Ở lại bao nhiêu phút thì Chibi được đội nón lá?", (f"{a} phút", f"{a + 7} phút", f"{max(1, a - 3)} giờ")))
            fresh = [q for q in bank if q[0] not in self._recent_quiz] or bank
            q, opts = self.rng.choice(fresh)
            self._recent_quiz = (self._recent_quiz + [q])[-10:]
            order = [0, 1, 2]
            self.rng.shuffle(order)
            return {"question": q, "options": [opts[i] for i in order], "answer": order.index(0)}
        word = self.rng.choice(KEYWORDS)
        return {"keyword": word, "folded": fold(word).replace(" ", "")}

    # ------------------------------------------------------------------ answers
    def answer(self, user: EventUser | None, name: str, text: str, avatar_id: str | None) -> str | None:
        """A comment during a round: 'answer' (counted), 'again' (already answered), or None
        (not an answer: the comment goes on as usual)."""
        r = self.round
        if r is None or r.phase not in ("intro", "open") or user is None or not user.identity_key:
            return None
        if r.kind == "price":
            value = parse_price(text)
        elif r.kind == "quiz":
            value = parse_choice(text)
        else:
            value = r.data["folded"] in fold(text).replace(" ", "") or None
        if value is None:
            return None
        key = user.identity_key
        if key in r.answers:
            return "again"
        r.answers[key] = Answer(key, name, self.clock(), value, avatar_id)
        if r.kind == "keyword" and len(r.answers) >= WINNERS:
            r.closes_at = self.clock()  # three fastest: done
        self._dirty = True
        return "answer"

    # ------------------------------------------------------------------ clock
    def tick(self) -> None:
        now = self.clock()
        live = bool(self.c.live.session_id)
        r = self.round
        if r is not None:
            if not live:
                self.round = None
                self.publish()
                return
            if r.phase == "intro" and now >= r.opens_at:
                r.phase = "open"
                self.publish()
            elif r.phase == "open" and now >= r.closes_at:
                self._reveal(r)
            elif r.phase == "reveal" and now >= r.ends_at:
                self.round = None
                self._schedule()
                self.publish()
            elif self._dirty and now - self._sent >= STATE_GAP_S:
                self.publish()
            return
        if not live or not self.cfg.minigame_enabled or not self.kinds_available():
            self.next_at = None
            return
        if self.next_at is None:
            self._schedule()
            self.publish()
        elif now >= self.next_at and self.c.speech.pending() <= 1:
            self.start()

    def _schedule(self) -> None:
        if not self.cfg.minigame_enabled or not self.c.live.session_id:
            self.next_at = None
            return
        lo, hi = sorted((self.cfg.minigame_every_min, self.cfg.minigame_every_max))
        self.next_at = self.clock() + self.rng.uniform(lo, hi) * 60

    def next_in(self) -> float | None:
        return None if self.next_at is None else max(0.0, self.next_at - self.clock())

    # ------------------------------------------------------------------ results
    def _reveal(self, r: Round) -> None:
        r.phase = "reveal"
        r.ends_at = self.clock() + REVEAL_S
        answers = sorted(r.answers.values(), key=lambda a: a.at)
        if r.kind == "price":
            price = r.data["price"]
            ranked = sorted(answers, key=lambda a: (abs(a.value - price), a.at))
            r.data["closest"] = [{"name": a.name, "guess": a.value} for a in ranked[:3]]
            win = ranked[:1]
        elif r.kind == "quiz":
            right = [a for a in answers if a.value == r.data["answer"]]
            r.data["right"] = len(right)
            win = right[:WINNERS]
        else:
            win = answers[:WINNERS]
        r.winners = [{"name": a.name, "key": a.key, "avatar_id": a.avatar_id} for a in win]
        for a in win:
            self.medals[a.key] = self.medals.get(a.key, 0) + 1
            self.c.board.add_game_win(a.key, a.name, self.c.live.session_id, self.c.live.is_demo)
            av = self.c.avatars._by_key.get(a.key)
            if av:
                av.medals = self.medals[a.key]
                if av.visible:
                    self.c.hub.send_game({"type": "AVATAR_MEDAL", "avatar_id": av.avatar_id, "medals": av.medals})
                    self.c.hub.send_game({"type": "SOCIAL_EFFECT", "kind": "cheer", "avatar_id": av.avatar_id})
        self.history.append({"id": r.id, "kind": r.kind, "title": TITLES[r.kind], "answers": len(r.answers),
                             "winners": [w["name"] for w in r.winners], "at": time.time()})
        del self.history[:-20]
        text = self._reveal_text(r)
        self._say(text, bubble=text)
        self.publish()

    # ------------------------------------------------------------------ words
    def _name(self, n: str) -> str:
        return speakable_name(n, self.c.assistant.config.banned_words)

    def _intro_text(self, r: Round) -> str:
        if r.kind == "price":
            return (f"Mini-game đoán giá! {r.data['product']} giá bao nhiêu? Bình luận con số, ví dụ 85 nghìn. "
                    "Ai đoán gần đúng nhất sẽ thắng!")
        if r.kind == "quiz":
            o = r.data["options"]
            return f"Đố vui nè! {r.data['question']} A: {o[0]}. B: {o[1]}. C: {o[2]}. Bình luận A, B hoặc C!"
        return f"Nhanh tay lên! Ba bạn bình luận đúng chữ {r.data['keyword']} đầu tiên sẽ thắng!"

    def _intro_bubble(self, r: Round) -> str:
        return {"price": f"Đoán giá {r.data.get('product', '')}!", "quiz": "Đố vui nè! Bình luận A, B hoặc C",
                "keyword": f"Ai gõ “{r.data.get('keyword', '')}” nhanh nhất?"}[r.kind]

    def _reveal_text(self, r: Round) -> str:
        names = ", ".join(self._name(w["name"]) for w in r.winners)
        if r.kind == "price":
            price = vnd(r.data["price"])
            if not r.winners:
                return f"Giá đúng là {price}. Chưa ai đoán, lần sau nha!"
            best = r.data["closest"][0]
            exact = best["guess"] == r.data["price"]
            return (f"Giá đúng là {price}! {names} đoán {vnd(best['guess'])}, "
                    + ("chính xác luôn! Chúc mừng!" if exact else "gần nhất! Chúc mừng!"))
        if r.kind == "quiz":
            letter = "ABC"[r.data["answer"]]
            right = r.data.get("right", 0)
            ans = f"Đáp án đúng là {letter}: {r.data['options'][r.data['answer']]}."
            if not right:
                return ans + " Chưa ai trả lời đúng, lần sau nha!"
            return ans + f" Có {right} bạn trả lời đúng, nhanh nhất là {names}!"
        if not r.winners:
            return "Hết giờ mà chưa ai gõ kịp, lần sau nha!"
        return f"Chúc mừng {names} nhanh tay nhất!"

    def _say(self, text: str, bubble: str) -> None:
        if self.c.scene.owner_enabled:
            self.c.owner.say(bubble, kind="game")
        if self.cfg.minigame_voice:
            self.c.assistant.announce("game", text)

    # ------------------------------------------------------------------ views
    def view(self) -> dict[str, Any] | None:
        """For the LIVE screen (never the right answer before the reveal)."""
        r = self.round
        if r is None:
            return None
        d = r.data
        out: dict[str, Any] = {"id": r.id, "kind": r.kind, "title": TITLES[r.kind], "phase": r.phase,
                               "opens_at": int(r.opens_at * 1000), "closes_at": int(r.closes_at * 1000),
                               "ends_at": int(r.ends_at * 1000), "answers": len(r.answers)}
        if r.kind == "price":
            out.update(product=d["product"], image=d["image"])
        elif r.kind == "quiz":
            out.update(question=d["question"], options=d["options"])
        else:
            out.update(keyword=d["keyword"])
        if r.phase == "reveal":
            out["winners"] = [w["name"] for w in r.winners]
            if r.kind == "price":
                out.update(price=d["price"], closest=d.get("closest", []))
            elif r.kind == "quiz":
                out.update(answer=d["answer"], right=d.get("right", 0))
        return out

    def dashboard_view(self) -> dict[str, Any]:
        nxt = self.next_in()
        return {"enabled": self.cfg.minigame_enabled, "round": self.view(), "next_in_s": None if nxt is None else round(nxt),
                "kinds": self.kinds_available(), "history": list(reversed(self.history[-8:])),
                "has_prices": bool(self._priced())}

    def publish(self) -> None:
        self._dirty = False
        self._sent = self.clock()
        v = self.view()
        self.c.hub.send_game({"type": "GAME_STATE", "game": v})
        self.c.hub.send_dashboard({"type": "GAME_STATE", "game": v})
