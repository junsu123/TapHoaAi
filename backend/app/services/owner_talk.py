"""The shop owner talks with the viewers.

* Ordinary comments: the owner answers by itself when it can (small talk, thanks, compliments,
  how to buy…) — no Claude call; only what it cannot answer goes to Claude (if allowed).
* Now and then, when the LIVE is quiet, the owner recites a short poem or tells a short story;
  a viewer can also ask for one ("làm thơ đi", "kể chuyện đi").

All built-in poems and stories are original, short, and make no health claims.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import random
import time
from collections import deque
from typing import TYPE_CHECKING, Any

from app.services.text_safety import contains_banned, risky_claims, speakable_name
from app.text_norm import fold

if TYPE_CHECKING:
    from app.container import AppContainer

log = logging.getLogger("chibi.talk")

# --------------------------------------------------------------------------- small talk
# (folded phrases, replies). A comment matches when one phrase appears as whole words.
SMALL_TALK: list[tuple[tuple[str, ...], tuple[str, ...]]] = [
    (("cam on", "thank", "thanks", "tks", "camon"), (
        "Dạ không có gì ạ, {ten} cần gì cứ hỏi shop nha!",
        "Shop mới phải cảm ơn {ten} đã ghé xem ạ!",
    )),
    (("dep qua", "dep the", "xinh qua", "xinh the", "de thuong", "cute", "dang yeu", "dep ghe", "xinh ghe"), (
        "Dạ cảm ơn {ten} nhiều ạ, khen vậy shop ngại quá!",
        "Hihi, cảm ơn {ten} ạ, {ten} cũng dễ thương lắm!",
    )),
    (("hay qua", "tuyet voi", "qua xin", "xin qua", "dinh qua", "hay ghe", "vui qua", "vui ghe", "live vui"), (
        "Dạ cảm ơn {ten}, có {ten} ở đây live vui hơn hẳn ạ!",
        "{ten} khen làm shop vui cả buổi luôn ạ!",
    )),
    (("tha tim", "yeu shop", "ung ho", "iu shop", "thuong shop", "love"), (
        "Shop cảm ơn {ten} đã ủng hộ ạ, thương {ten} nhiều!",
        "Cảm ơn {ten} đã thả tim cho quán nhỏ ạ!",
    )),
    (("khoe khong", "co khoe", "khoe ko", "khoe hong", "on khong"), (
        "Dạ shop khỏe ạ, cảm ơn {ten} đã hỏi thăm! {ten} cũng khỏe nha.",
    )),
    (("an com chua", "an chua", "an toi chua", "an trua chua", "an sang chua"), (
        "Dạ shop vừa nhâm nhi chén trà nóng rồi ạ, {ten} nhớ ăn uống đầy đủ nha!",
    )),
    (("mua qua", "troi mua", "nong qua", "lanh qua", "troi lanh", "troi nong"), (
        "Thời tiết thế này mà có chén trà ấm thì tuyệt lắm {ten} ạ!",
    )),
    (("nhac hay", "bai gi", "nhac gi"), (
        "Dạ cảm ơn {ten}, nhạc nhẹ để mọi người thư giãn cùng quán đó ạ!",
    )),
    (("haha", "hihi", "hehe", "kkk", "hahaha", "kaka", "huhu"), (
        "Hihi, {ten} vui là shop vui rồi ạ!",
    )),
    (("buon ngu", "met qua", "met moi", "buon qua", "chan qua"), (
        "{ten} nghỉ ngơi chút, nghe nhạc, nhâm nhi chén trà cho thư thái nha!",
    )),
    (("moi vao", "vua vao", "moi den", "vua toi", "gio moi vao"), (
        "Chào mừng {ten} ghé quán ạ, cứ tự nhiên như ở nhà nha!",
    )),
    (("chot don", "dat hang", "mua sao", "mua o dau", "dat sao", "len don"), (
        "Dạ {ten} bấm vào giỏ hàng trên LIVE để đặt nhé, shop gói hàng ngay ạ!",
    )),
    (("theo doi", "follow", "da follow", "da theo doi"), (
        "Cảm ơn {ten} đã theo dõi quán ạ, có LIVE mới shop báo ngay!",
    )),
    (("bao gio live", "mai live", "lan sau", "mai co live", "live tiep"), (
        "Dạ quán LIVE thường xuyên lắm, {ten} bấm theo dõi để không bỏ lỡ nha!",
    )),
    (("ngu ngon", "chuc ngu ngon", "di ngu", "good night"), (
        "Chúc {ten} ngủ thật ngon, mai lại ghé quán nha!",
    )),
    (("chuc shop", "chuc quan", "dat hang nhieu", "dong khach", "dat khach", "buon may ban dat"), (
        "Shop cảm ơn lời chúc của {ten} ạ, chúc {ten} cũng thật nhiều may mắn!",
    )),
]


def local_reply(text: str, name: str, rng: random.Random | None = None) -> str | None:
    """The owner's own answer to an ordinary comment, or None (→ Claude, if allowed)."""
    padded = f" {fold(text)} "
    for phrases, replies in SMALL_TALK:
        if any(f" {p} " in padded for p in phrases):
            r = (rng or random).choice(replies)
            return r.replace("{ten}", name)
    return None


# --------------------------------------------------------------------------- poems & stories
POEMS: list[str] = [
    "Chiều nay ghé quán trà xanh,\nHương thơm thảo mộc quẩn quanh hiên nhà.\nMời nhau một chén trà hoa,\nCâu chào câu chuyện mặn mà tình thân.",
    "Ấm trà vừa rót còn thơm,\nBạn ơi ghé lại, sớm hôm có nhà.\nLá xanh hái tự vườn xa,\nPha bằng nắng gió, pha bằng niềm vui.",
    "Mưa rơi lất phất ngoài hiên,\nChén trà nóng hổi ưu phiền bay xa.\nLive đây có quán có nhà,\nCó người chủ nhỏ mời trà mỗi đêm.",
    "Cảm ơn bạn ghé xem live,\nThả tim một cái, chủ quên mệt nhoài.\nTrà thơm chẳng tiếc một ai,\nMời người ở lại, đêm dài thêm vui.",
    "Cà gai leo mọc bờ rào,\nPhơi khô sắc nước ngọt ngào màu nâu.\nBa kích tím tựa hoa cau,\nHai chàng thảo mộc rủ nhau vào nhà.",
    "Sáng ra pha ấm trà đầy,\nNghe chim ríu rít, nghe ngày sang trang.\nChúc ai một sớm bình an,\nLòng như chén nước, nhẹ nhàng mà trong.",
    "Gió đưa hương lá về đây,\nAi qua ghé lại, đôi tay chén trà.\nĐường xa thì cứ đi xa,\nNhớ còn một quán nhà ta đợi chờ.",
    "Đêm nay quán sáng đèn vàng,\nChibi nhảy múa rộn ràng khắp nơi.\nBạn ơi nhắn một câu thôi,\nChủ quán đọc hết, trả lời từng người.",
]

STORIES: list[str] = [
    (
        "Chuyện ấm trà của bà. Ngày xưa, bà nội tôi có một chiếc ấm đất nhỏ, sứt một góc vòi. Mỗi sáng bà pha trà, "
        "rót cho ông một chén, rồi rót cho mình một chén. Tôi hỏi sao bà không mua ấm mới. Bà cười, bảo ấm cũ giữ được "
        "hương của bao nhiêu buổi sáng sum vầy. Từ đó tôi hiểu, chén trà ngon nhất là chén trà uống cùng người thương."
    ),
    (
        "Chuyện cây cà gai leo bờ rào. Ở quê tôi, cà gai leo mọc dọc bờ rào, gai nhỏ, hoa tím xinh xinh. Trẻ con đi học về "
        "hay ghé hái quả chơi, bị gai cào là chạy về mách mẹ. Mẹ chỉ cười, bảo cây nào cũng có cách tự bảo vệ mình, như "
        "người hiền vẫn cần chút cứng cỏi. Giờ mỗi lần thấy gói trà cà gai leo, tôi lại nhớ con đường làng ngày ấy."
    ),
    (
        "Chuyện vị khách đầu tiên. Hôm quán mới mở, trời mưa to, chẳng ai ghé. Đến tối có một chú xe ôm vào trú mưa, chủ "
        "quán mời chú chén trà nóng không lấy tiền. Tuần sau chú quay lại, dẫn theo cả nhóm bạn. Chủ quán nhận ra, quán "
        "nhỏ thì cần nhất là một tấm lòng mở cửa."
    ),
    (
        "Chuyện con mèo canh quán. Quán có một chú mèo vàng tên Mứt. Mứt thích nằm cạnh ấm trà vì ấm lúc nào cũng ấm. "
        "Khách vào, Mứt chỉ mở một mắt nhìn rồi ngủ tiếp, như muốn nói cứ tự nhiên như ở nhà. Nhiều người ghé quán chỉ để "
        "vuốt Mứt một cái, rồi ở lại uống thêm một chén trà."
    ),
    (
        "Chuyện lá trà và hạt mưa. Có một chiếc lá trà kiêu hãnh vì mình thơm nhất vườn. Một hôm mưa rơi, chiếc lá than "
        "mưa làm ướt mình rồi. Hạt mưa đáp, không có mình thì bạn đâu có xanh như thế. Chiếc lá im lặng, và từ đó biết "
        "cảm ơn những điều nhỏ bé quanh mình."
    ),
    (
        "Chuyện chén trà mời người lạ. Một buổi chiều, có cô gái đứng trước quán rất lâu mà không vào. Chủ quán bưng ra "
        "một chén trà, chỉ nói trời nóng, cô uống cho mát. Cô gái kể hôm nay cô vừa thi trượt. Uống xong chén trà, cô "
        "cười và bảo năm sau sẽ thi lại. Năm sau, cô quay lại quán với tờ giấy báo đỗ trong tay."
    ),
    (
        "Chuyện hai ông bạn già. Ở góc quán có hai ông bạn già, chiều nào cũng đánh cờ. Ông thắng thì được rót trà, ông "
        "thua thì phải kể một chuyện vui. Đã ba năm, chẳng ai nhớ ai thắng nhiều hơn, chỉ nhớ những buổi chiều cười rộn "
        "cả góc phố."
    ),
    (
        "Chuyện gói trà gửi mẹ. Một bạn sinh viên mua gói trà nhỏ ở quán, nhờ gói thật đẹp để gửi về quê cho mẹ. Bạn "
        "bảo con chưa đủ tiền mua quà lớn, chỉ có chút trà thơm thay lời hỏi thăm. Chủ quán gói thêm tấm thiệp, viết "
        "mẹ ơi, con nhớ mẹ. Mấy hôm sau, bạn nhắn rằng mẹ đã khóc khi mở gói trà."
    ),
]

POEM_SCHEMA = {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"],
               "additionalProperties": False}
POEM_SYSTEM = (
    "Bạn là chủ một quán trà thảo mộc nhỏ đang LIVE bán hàng. Viết MỘT bài thơ lục bát 4 câu (6-8-6-8 chữ), "
    "tiếng Việt, ấm áp, vui vẻ, về quán trà, chén trà, người xem LIVE. Không nói công dụng, không hứa chữa bệnh, "
    "không nhắc bệnh tật hay thuốc, không nêu giá. Mỗi câu một dòng. Trả về JSON {\"text\": \"...\"}."
)

REQUEST_GAP_S = 45.0  # one poem / story at a time on request
VIEWER_AGAIN_S = 180.0  # the same viewer asks again: wait


class OwnerTalk:
    def __init__(self, c: AppContainer, clock=time.monotonic):
        self.c = c
        self.clock = clock
        self.rng = random.Random()
        self._order: dict[str, list[int]] = {"poem": [], "story": []}
        self._last_any = -1e9
        self._last_auto = clock()
        self._by_viewer: dict[str, float] = {}
        self.history: deque[dict[str, Any]] = deque(maxlen=30)
        self._task: asyncio.Task | None = None
        self._busy = False

    @property
    def cfg(self):
        return self.c.assistant.config

    # ------------------------------------------------------------------ small talk
    def reply(self, text: str, name: str | None) -> str | None:
        cfg = self.cfg
        if not cfg.owner_chat:
            return None
        if contains_banned(text, cfg.banned_words):
            return None
        return local_reply(text, speakable_name(name, cfg.banned_words), self.rng)

    # ------------------------------------------------------------------ poems & stories
    def _library(self, kind: str) -> list[str]:
        cfg = self.cfg
        own = [t.strip() for t in (cfg.custom_poems if kind == "poem" else cfg.custom_stories) if t.strip()]
        base = POEMS if kind == "poem" else STORIES
        return own + base if cfg.poem_story_builtin else (own or base)

    def pick(self, kind: str) -> str:
        """Next one from the list, every one before any repeats (shuffled order)."""
        lib = self._library(kind)
        order = self._order[kind]
        order[:] = [i for i in order if i < len(lib)]
        if not order:
            order.extend(self.rng.sample(range(len(lib)), len(lib)))
        return lib[order.pop()]

    def request(self, kind: str, name: str | None, viewer: str | None) -> str:
        """A viewer asked ("làm thơ đi", "kể chuyện đi")."""
        cfg = self.cfg
        if not cfg.poem_story:
            return f"{kind}_off"
        ok, _ = self.c.assistant.voice_ready()
        if not ok:
            return f"{kind}_off"
        now = self.clock()
        if viewer and now - self._by_viewer.get(viewer, -1e9) < VIEWER_AGAIN_S:
            return f"{kind}_again_later"
        if self._busy or now - self._last_any < REQUEST_GAP_S:
            return f"{kind}_too_soon"
        if viewer:
            self._by_viewer[viewer] = now
            if len(self._by_viewer) > 5000:
                self._by_viewer = {k: t for k, t in self._by_viewer.items() if now - t < VIEWER_AGAIN_S}
        self._start(kind, name)
        return f"{kind}_queued"

    def _start(self, kind: str, name: str | None) -> None:
        self._busy = True
        self._last_any = self.clock()
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            self._busy = False
            return
        t = loop.create_task(self._perform(kind, name))
        self.c.assistant._tasks.add(t)
        t.add_done_callback(self.c.assistant._tasks.discard)

    async def _perform(self, kind: str, name: str | None) -> None:
        try:
            text, source = await self._compose(kind, name)
            cfg = self.cfg
            who = speakable_name(name, cfg.banned_words) if name else None
            if kind == "poem":
                intro = f"Tặng {who} một bài thơ nhỏ:" if who else "Chủ quán đọc tặng cả nhà một bài thơ:"
            else:
                intro = f"{who} ơi, nghe chủ quán kể chuyện nha." if who else "Chủ quán kể cả nhà nghe một chuyện nhỏ nha."
            spoken = f"{intro}\n{text}"
            clip = self.c.speech.enqueue(kind, spoken, droppable=True, busy_limit=cfg.busy_limit + 1, ttl=120.0)
            ok = clip is not None
            self.history.append({"kind": kind, "for": name, "source": source, "spoken": ok, "at": time.time(),
                                 "text": text[:200]})
            self.c.assistant._trace(kind, name or "cả nhà", text[:80], ok,
                                    "Chủ quán đọc trên LIVE." if ok else "Đang có nhiều câu chờ đọc — để lần sau.")
        except Exception:
            log.exception("Chủ quán không đọc được thơ/truyện")
        finally:
            self._busy = False

    async def _compose(self, kind: str, name: str | None) -> tuple[str, str]:
        """(text, source). A poem may be written by Claude if allowed; always checked."""
        cfg = self.cfg
        a = self.c.assistant
        key = a.api_key()
        if kind == "poem" and cfg.poem_story_claude and key and not self.c.ai_paused:
            worst = a.budget.worst_case(cfg.model, len(POEM_SYSTEM) + 200, 300)
            if a.budget.allows(worst, cfg.budget_day_usd, cfg.budget_month_usd):
                try:
                    user = f"Quán: {cfg.shop_name}. " + (f"Tặng người xem tên {name}." if name else "Tặng cả nhà đang xem.")
                    comp = await asyncio.wait_for(
                        a.client.complete(api_key=key, model=cfg.model, system=POEM_SYSTEM, user=user,
                                          schema=POEM_SCHEMA, max_tokens=300), timeout=20.0)
                    a.budget.record(cfg.model, comp.tokens_in, comp.tokens_out, cfg.budget_day_usd, cfg.budget_month_usd)
                    text = str(json.loads(comp.text).get("text") or "").strip()
                    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
                    if (2 <= len(lines) <= 8 and len(text) <= 400 and not risky_claims(text)
                            and not contains_banned(text, cfg.banned_words)):
                        return "\n".join(lines), "claude"
                except Exception as exc:  # noqa: BLE001 - never stop the show for a poem
                    log.info("Claude không làm thơ được (%s) — dùng thơ có sẵn", type(exc).__name__)
        return self.pick(kind), "library"

    # ------------------------------------------------------------------ now and then
    def start(self) -> None:
        self._task = asyncio.create_task(self._loop(), name="owner-talk")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task

    async def _loop(self) -> None:
        while True:
            await asyncio.sleep(5.0)
            with contextlib.suppress(Exception):
                self.tick()

    def tick(self) -> bool:
        """When the LIVE is quiet: a poem or a story every `poem_story_every_min` minutes."""
        cfg = self.cfg
        every = cfg.poem_story_every_min
        if not cfg.poem_story or every <= 0 or self._busy or not self.c.live.session_id:
            return False
        now = self.clock()
        if now - self._last_auto < every * 60 or now - self._last_any < 60:
            return False
        if self.c.speech.pending() > 0 or not self.c.assistant.voice_ready()[0]:
            return False  # someone is being answered: never interrupt for a poem
        self._last_auto = now
        kind = "poem" if len(self.history) % 2 == 0 else "story"
        self._start(kind, None)
        return True

    def view(self) -> dict[str, Any]:
        return {"history": list(self.history)[-10:], "poems": len(self._library("poem")),
                "stories": len(self._library("story"))}
