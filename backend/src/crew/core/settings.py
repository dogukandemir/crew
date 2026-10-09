"""Runtime settings (docs/01 §6, .env.example). One validated Settings object, built at boot."""

from __future__ import annotations

import base64
import os
import secrets
from functools import lru_cache
from pathlib import Path

from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def _a(*names: str) -> AliasChoices:
    return AliasChoices(*names)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", "../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
        case_sensitive=False,
    )

    # ── server ────────────────────────────────────────────────────────────────
    env: str = Field("dev", validation_alias=_a("CREW_ENV", "env"))
    host: str = Field("127.0.0.1", validation_alias=_a("CREW_HOST", "host"))
    port: int = Field(8787, validation_alias=_a("CREW_PORT", "port"))
    log_level: str = Field("info", validation_alias=_a("CREW_LOG_LEVEL", "log_level"))
    data_dir: Path = Field(Path("../data"), validation_alias=_a("CREW_DATA_DIR", "data_dir"))
    # Company workspace root (ADR 0017). Empty → ~/crew/workspace, resolved lazily so
    # tests can point CREW_WORKSPACE_ROOT at a tmp dir and never touch a real home dir.
    workspace_root: str = Field("", validation_alias=_a("CREW_WORKSPACE_ROOT", "workspace_root"))
    cors_origins: str = Field("http://localhost:5173,http://127.0.0.1:5173",
                              validation_alias=_a("CREW_CORS_ORIGINS", "cors_origins"))
    validate_events: bool = Field(True, validation_alias=_a("CREW_VALIDATE_EVENTS", "validate_events"))

    # ── auth ──────────────────────────────────────────────────────────────────
    auth_mode: str = Field("local", validation_alias=_a("CREW_AUTH_MODE", "auth_mode"))
    jwt_secret: str = Field("", validation_alias=_a("CREW_JWT_SECRET", "jwt_secret"))
    access_token_ttl_min: int = Field(720, validation_alias=_a("CREW_ACCESS_TOKEN_TTL_MIN", "access_token_ttl_min"))
    vault_key: str = Field("", validation_alias=_a("CREW_VAULT_KEY", "vault_key"))

    # ── model providers ───────────────────────────────────────────────────────
    deepseek_api_key: str = Field("", validation_alias=_a("DEEPSEEK_API_KEY", "deepseek_api_key"))
    openai_api_key: str = Field("", validation_alias=_a("OPENAI_API_KEY", "openai_api_key"))
    anthropic_api_key: str = Field("", validation_alias=_a("ANTHROPIC_API_KEY", "anthropic_api_key"))
    gemini_api_key: str = Field("", validation_alias=_a("GEMINI_API_KEY", "gemini_api_key"))
    openrouter_api_key: str = Field("", validation_alias=_a("OPENROUTER_API_KEY", "openrouter_api_key"))
    ollama_base_url: str = Field("", validation_alias=_a("OLLAMA_BASE_URL", "ollama_base_url"))

    # Tier routing (docs/04). Defaults ride DeepSeek V4 (Apr 2026): `deepseek-flash`
    # (V4.1-Flash) and `deepseek-v4-pro`. The legacy names `deepseek-chat` /
    # `deepseek-reasoner` were retired by the provider on 2026-07-24 — never pin them.
    tier_reasoning: str = Field("deepseek/deepseek-v4-pro", validation_alias=_a("CREW_TIER_REASONING", "tier_reasoning"))
    tier_standard: str = Field("deepseek/deepseek-flash", validation_alias=_a("CREW_TIER_STANDARD", "tier_standard"))
    tier_fast: str = Field("deepseek/deepseek-flash", validation_alias=_a("CREW_TIER_FAST", "tier_fast"))
    tier_embed: str = Field("openai/text-embedding-3-small", validation_alias=_a("CREW_TIER_EMBED", "tier_embed"))
    # DeepSeek V4 made thinking a request parameter: reasoning_effort (low|high|max).
    # Applied to DeepSeek models at LLM construction; other providers never see it.
    reasoning_effort: str = Field("high", validation_alias=_a("CREW_REASONING_EFFORT", "reasoning_effort"))

    # ── safety rails ──────────────────────────────────────────────────────────
    max_concurrent_crews: int = Field(2, validation_alias=_a("CREW_MAX_CONCURRENT_CREWS", "max_concurrent_crews"))
    max_agents_per_project: int = Field(24, validation_alias=_a("CREW_MAX_AGENTS_PER_PROJECT", "max_agents_per_project"))
    max_departments_per_project: int = Field(6, validation_alias=_a("CREW_MAX_DEPARTMENTS_PER_PROJECT", "max_departments_per_project"))
    default_project_budget_usd: float = Field(10.0, validation_alias=_a("CREW_DEFAULT_PROJECT_BUDGET_USD", "default_project_budget_usd"))
    hard_budget_usd: float = Field(50.0, validation_alias=_a("CREW_HARD_BUDGET_USD", "hard_budget_usd"))
    tool_sandbox: str = Field("docker", validation_alias=_a("CREW_TOOL_SANDBOX", "tool_sandbox"))
    egress_allowlist: str = Field("", validation_alias=_a("CREW_EGRESS_ALLOWLIST", "egress_allowlist"))
    require_approval_above_usd: float = Field(2.0, validation_alias=_a("CREW_REQUIRE_APPROVAL_ABOVE_USD", "require_approval_above_usd"))
    auto_hire_default: bool = Field(True, validation_alias=_a("CREW_AUTO_HIRE_DEFAULT", "auto_hire_default"))
    offline_llm: bool = Field(False, validation_alias=_a("CREW_OFFLINE_LLM", "offline_llm"))

    # ── validation ────────────────────────────────────────────────────────────
    @field_validator("auth_mode")
    @classmethod
    def _auth_mode(cls, v: str) -> str:
        if v not in ("local", "token"):
            raise ValueError("CREW_AUTH_MODE must be 'local' or 'token'")
        return v

    @field_validator("tool_sandbox")
    @classmethod
    def _sandbox(cls, v: str) -> str:
        # Host execution was removed (ADR 0017): commands run in the container or not at
        # all. `subprocess` (and the old "none") are legacy spellings and resolve to
        # `docker`; the field is informational now, not a switch.
        if v in ("subprocess", "none"):
            return "docker"
        if v != "docker":
            raise ValueError("CREW_TOOL_SANDBOX must be docker (legacy: subprocess→docker)")
        return v

    @field_validator("reasoning_effort")
    @classmethod
    def _effort(cls, v: str) -> str:
        if v not in ("low", "high", "max"):
            raise ValueError("CREW_REASONING_EFFORT must be one of low|high|max")
        return v

    def model_post_init(self, __context) -> None:  # noqa: D105
        # Fail loudly rather than run an unauthenticated service on a public interface.
        if self.auth_mode == "local" and self.env != "dev" and self.host not in ("127.0.0.1", "localhost", "::1"):
            raise RuntimeError(
                "refusing to bind a non-loopback address with CREW_AUTH_MODE=local outside dev"
            )

    # ── derived ───────────────────────────────────────────────────────────────
    @property
    def data_path(self) -> Path:
        p = self.data_dir if self.data_dir.is_absolute() else (Path.cwd() / self.data_dir)
        return p.resolve()

    @property
    def db_path(self) -> Path:
        return self.data_path / "crew.db"

    @property
    def db_url(self) -> str:
        return os.environ.get("CREW_DATABASE_URL") or f"sqlite+aiosqlite:///{self.db_path.as_posix()}"

    @property
    def projects_dir(self) -> Path:
        return self.data_path / "projects"

    def workspace_dir(self, project_id: str) -> Path:
        return self.projects_dir / project_id / "workspace"

    def artifacts_dir(self, project_id: str) -> Path:
        return self.projects_dir / project_id / "artifacts"

    @property
    def default_workspace_root(self) -> Path:
        """`~/crew/workspace` unless CREW_WORKSPACE_ROOT overrides it (ADR 0017)."""
        if self.workspace_root.strip():
            return Path(self.workspace_root.strip()).expanduser().resolve()
        return (Path.home() / "crew" / "workspace").resolve()

    def quarantine_dir(self, project_id: str) -> Path:
        """Where reviewed-risky web content waits for a human decision (ADR 0017)."""
        return self.projects_dir / project_id / "quarantine"

    @property
    def cors_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def egress_extra(self) -> list[str]:
        return [d.strip() for d in self.egress_allowlist.split(",") if d.strip()]

    @property
    def is_dev(self) -> bool:
        return self.env == "dev"

    def ensure_dirs(self) -> None:
        self.data_path.mkdir(parents=True, exist_ok=True)
        self.projects_dir.mkdir(parents=True, exist_ok=True)

    def provider_key_for(self, model: str) -> str:
        provider = model.split("/", 1)[0].lower() if "/" in model else "openai"
        return {
            "deepseek": self.deepseek_api_key,
            "openai": self.openai_api_key,
            "anthropic": self.anthropic_api_key,
            "gemini": self.gemini_api_key,
            "google": self.gemini_api_key,
            "openrouter": self.openrouter_api_key,
            "ollama": "ollama",
        }.get(provider, "")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    s = Settings()
    s.ensure_dirs()
    if not s.vault_key:
        # No master key configured: generate one ONCE and keep it beside the data it
        # protects. A session-only key would silently orphan every stored secret on
        # restart — and the first thing the vault stores is a provider key.
        key_file = s.data_path / "vault.key"
        if key_file.exists():
            s.vault_key = key_file.read_text(encoding="utf-8").strip()
        else:
            s.vault_key = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode()
            key_file.write_text(s.vault_key, encoding="utf-8")
    return s


def reset_settings_cache() -> None:
    get_settings.cache_clear()


settings = get_settings()
