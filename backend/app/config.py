"""Application settings. Values come from environment variables prefixed CHIBI_
(or a local .env file). Secrets such as the Claude API key are NOT configured here:
they are entered in the dashboard and stored encrypted in the database."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = BACKEND_DIR.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="CHIBI_", env_file=".env", extra="ignore")

    # --- runtime -----------------------------------------------------------
    host: str = "127.0.0.1"
    port: int = 8686  # CHIBI_PORT; avoids the commonly busy 8000
    data_dir: Path = REPO_DIR / "data"
    database_url: str | None = None  # default: sqlite:///<data_dir>/chibi.db
    frontend_dist: Path = REPO_DIR / "frontend" / "dist"
    cors_origins: list[str] = Field(
        default_factory=lambda: ["http://127.0.0.1:5173", "http://localhost:5173"]
    )

    # --- security ----------------------------------------------------------
    cookie_secure: bool = False  # set True when served over HTTPS
    session_ttl_minutes: int = 12 * 60
    login_max_failures: int = 5
    login_lock_minutes: int = 15
    demo_rate_per_minute: int = 600

    # --- feature flags -----------------------------------------------------
    demo_enabled: bool = True
    # AI-06: the voice is off until the owner turns it on in the dashboard (after the policy
    # checklist); CHIBI_TTS_LOCKED=1 keeps it off whatever the dashboard says.
    tts_locked: bool = False
    # offline stand-ins for Claude and the voice (demos, automated tests) — never for a real LIVE
    fake_ai: bool = False

    # --- game / queue tuning (PRD C3, C4, GAME-11) --------------------------
    max_visible_avatars: int = 60
    # TikTok sends no "viewer left" event: a Chibi leaves after this long without any
    # interaction (comment, like, gift, follow, share, join). Adjustable in the dashboard.
    avatar_idle_exit_seconds: int = 300
    command_cooldown_seconds: float = 5.0
    max_pending_per_viewer: int = 2
    show_seconds: float = 8.0
    reservation_ttl_seconds: float = 15.0
    ack_timeout_seconds: float = 5.0
    action_timeout_seconds: float = 45.0
    camera_min_hold_seconds: float = 4.0

    # --- matcher thresholds (experimental, tune with Vietnamese dataset) ----
    match_high_confidence: float = 0.90
    match_suggest_floor: float = 0.75
    match_ambiguity_margin: float = 0.05

    # --- retention ----------------------------------------------------------
    event_retention_days: int = 7

    # --- event bus -----------------------------------------------------------
    bus_max_size: int = 2000

    @property
    def resolved_database_url(self) -> str:
        if self.database_url:
            return self.database_url
        return f"sqlite:///{self.data_dir / 'chibi.db'}"

    @property
    def media_dir(self) -> Path:
        return self.data_dir / "media"


@lru_cache
def get_settings() -> Settings:
    return Settings()
