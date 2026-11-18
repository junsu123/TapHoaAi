"""Comments with banned words.

The shop keeps its own list of banned words (besides a short built-in list of swear words). A
comment with one of them is never read aloud, answered, or used to learn; the host can teach a new
word from any comment on the dashboard ("Cấm từ…"), and from then on the same word is caught.

What happens to such a comment is the shop's choice:
* skip — nothing is said;
* remind — the owner gently reminds the viewer (by name, without repeating the word), at most once
  every 5 minutes per viewer and once every 30 seconds overall, so trolls get no show.
A viewer who keeps doing it (``banned_mute_after`` comments in one LIVE) is muted until the LIVE
ends: none of their comments are read; the host can lift that.
"""

from __future__ import annotations

import time
from collections import deque
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from app.services.text_safety import BUILTIN_BANNED, find_banned, speakable_name
from app.text_norm import fold

if TYPE_CHECKING:
    from app.container import AppContainer

REMIND_GAP_S = 30.0
REMIND_VIEWER_GAP_S = 300.0
RECENT = 60


class Moderation:
    def __init__(self, c: AppContainer, clock=time.monotonic):
        self.c = c
        self.clock = clock
        self.recent: deque[dict[str, Any]] = deque(maxlen=RECENT)
        self._strikes: dict[str, int] = {}
        self.muted: dict[str, str] = {}  # viewer key → name, until the LIVE ends
        self._reminded: dict[str, float] = {}
        self._last_remind = -1e9
        self.blocked_total = 0

    @property
    def cfg(self):
        return self.c.assistant.config

    def reset(self) -> None:
        """A new LIVE: strikes and mutes start over (the word list stays)."""
        self._strikes.clear()
        self.muted.clear()
        self._reminded.clear()
        self._last_remind = -1e9

    # ------------------------------------------------------------------ live comments
    def check(self, record: dict[str, Any], viewer_key: str | None) -> str | None:
        """None when the comment may go on; otherwise why not (the comment is then left alone:
        not read, not answered). Marks the record for the dashboard."""
        name = record.get("nickname") or record.get("unique_id")
        if viewer_key and viewer_key in self.muted:
            record["blocked"] = "Đang tạm không đọc bình luận của người này"
            self._log(record, None, reminded=False, muted=True)
            return record["blocked"]
        cfg = self.cfg
        word = find_banned(record.get("text") or "", cfg.banned_words)
        if word is None:
            return None
        self.blocked_total += 1
        muted = False
        if viewer_key:
            n = self._strikes.get(viewer_key, 0) + 1
            self._strikes[viewer_key] = n
            if cfg.banned_mute_after and n >= cfg.banned_mute_after:
                self.muted[viewer_key] = name or "?"
                muted = True
        reminded = self._remind(name, viewer_key) if cfg.banned_action == "remind" and not muted else False
        record["blocked"] = f"Có từ cấm “{word}”" + (" — chủ quán đã nhắc nhở" if reminded else "") + (
            " — tạm không đọc bình luận của người này tới hết buổi LIVE" if muted else "")
        self._log(record, word, reminded=reminded, muted=muted)
        self.c.assistant._trace("comment", name, record.get("text"), False, record["blocked"])
        return record["blocked"]

    def _remind(self, name: str | None, viewer_key: str | None) -> bool:
        now = self.clock()
        if now - self._last_remind < REMIND_GAP_S:
            return False
        if viewer_key and now - self._reminded.get(viewer_key, -1e9) < REMIND_VIEWER_GAP_S:
            return False
        cfg = self.cfg
        ten = speakable_name(name, cfg.banned_words) if name else "bạn"
        try:
            text = cfg.banned_remind_template.format(ten=ten)
        except (KeyError, IndexError, ValueError):
            text = f"Bạn {ten} ơi, quán mình nói chuyện nhẹ nhàng với nhau nha!"
        self._last_remind = now
        if viewer_key:
            self._reminded[viewer_key] = now
        self.c.owner.say(text, kind="talk")
        self.c.assistant.announce("remind", text)
        return True

    def _log(self, record: dict[str, Any], word: str | None, *, reminded: bool, muted: bool) -> None:
        entry = {"at": datetime.now(UTC).isoformat(), "event_id": record.get("event_id"),
                 "name": record.get("nickname") or record.get("unique_id"), "text": (record.get("text") or "")[:200],
                 "word": word, "reminded": reminded, "muted": muted, "is_demo": bool(record.get("is_demo"))}
        self.recent.appendleft(entry)
        self.c.hub.send_dashboard({"type": "MODERATION", "entry": entry})

    def unmute(self, key: str) -> bool:
        self._strikes.pop(key, None)
        return self.muted.pop(key, None) is not None

    # ------------------------------------------------------------------ the shop's word list
    def add_word(self, word: str) -> list[str]:
        cfg = self.cfg
        w = " ".join(word.split())
        if fold(w) and all(fold(x) != fold(w) for x in cfg.banned_words):
            new = cfg.model_copy(update={"banned_words": sorted([*cfg.banned_words, w], key=fold)[:200]})
            self.c.assistant.update_config(new)
        return list(self.cfg.banned_words)

    def remove_word(self, word: str) -> list[str]:
        cfg = self.cfg
        left = [x for x in cfg.banned_words if fold(x) != fold(word)]
        if len(left) != len(cfg.banned_words):
            self.c.assistant.update_config(cfg.model_copy(update={"banned_words": left}))
        return list(self.cfg.banned_words)

    def view(self) -> dict[str, Any]:
        cfg = self.cfg
        return {"words": list(cfg.banned_words), "builtin": list(BUILTIN_BANNED), "action": cfg.banned_action,
                "remind_template": cfg.banned_remind_template, "mute_after": cfg.banned_mute_after,
                "recent": list(self.recent), "blocked_total": self.blocked_total,
                "muted": [{"key": k, "name": n} for k, n in self.muted.items()]}
