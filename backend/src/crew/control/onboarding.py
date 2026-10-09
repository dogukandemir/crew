"""First-run onboarding (ADR 0013): the user picks a provider once.

The key is verified against the provider, stored ENCRYPTED in the vault (never in
plaintext, never returned again), and made effective in-process — `os.environ` for the
CrewAI/LiteLLM layer, the settings object for our own routing — so nothing needs a
`.env` edit or a restart. Picking a provider also points the model tiers at it
(`PROVIDER_PRESETS`, persisted to `data/provider.json`), because a saved key the
routing never reads would be a dead end. On boot, stored keys and the picker's choice
are loaded back, so onboarding survives.

Positioning (deliberate): **Ollama here means LOCAL Ollama** — the machine's own
server, no key, zero spend, verified by reaching it. Ollama's *cloud* models are
served through OpenRouter's API and key (openrouter.ai/provider/ollama), so they ride
under the OpenRouter entry instead of a separate picker tile.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
from datetime import UTC, datetime

import httpx

from crew.core.security import vault
from crew.core.settings import settings

log = logging.getLogger(__name__)

DEFAULT_OLLAMA_BASE = "http://localhost:11434"

# provider → (env var the runner reads, settings field, verification endpoint or None)
# The endpoint is the provider's models list: 401/403 there means THE KEY IS WRONG.
PROVIDERS: dict[str, tuple[str, str, str | None]] = {
    "deepseek": ("DEEPSEEK_API_KEY", "deepseek_api_key", "https://api.deepseek.com/models"),
    "openai": ("OPENAI_API_KEY", "openai_api_key", "https://api.openai.com/v1/models"),
    "anthropic": ("ANTHROPIC_API_KEY", "anthropic_api_key",
                  "https://api.anthropic.com/v1/models"),
    "openrouter": ("OPENROUTER_API_KEY", "openrouter_api_key",
                   "https://openrouter.ai/api/v1/models"),
    # Local Ollama: the "key" slot carries its base URL; there is no secret. The
    # cloud side deliberately has no entry here — it is reached through OpenRouter.
    "ollama": ("OLLAMA_BASE_URL", "ollama_base_url", None),
    # Kept for backwards compatibility (env-only; no picker tile, no live check).
    "gemini": ("GEMINI_API_KEY", "gemini_api_key", None),
}

# What the first-run card renders as the picker: label, logo id, input shape, hint,
# and where a key comes from. Order is display order; DeepSeek is the shipped default.
PROVIDER_META: list[dict] = [
    {"id": "deepseek", "label": "DeepSeek", "kind": "key", "placeholder": "sk-…",
     "hint": "The shipped default — cheap flagship tiers",
     "console": "https://platform.deepseek.com/api_keys"},
    {"id": "openai", "label": "OpenAI", "kind": "key", "placeholder": "sk-…",
     "hint": "GPT models — also powers embeddings (semantic recall)",
     "console": "https://platform.openai.com/api-keys"},
    {"id": "anthropic", "label": "Anthropic", "kind": "key", "placeholder": "sk-ant-…",
     "hint": "Claude models",
     "console": "https://console.anthropic.com/settings/keys"},
    {"id": "openrouter", "label": "OpenRouter", "kind": "key", "placeholder": "sk-or-…",
     "hint": "One key, hundreds of models — incl. hosted Ollama cloud models",
     "console": "https://openrouter.ai/settings/keys"},
    {"id": "ollama", "label": "Ollama", "kind": "local", "placeholder": DEFAULT_OLLAMA_BASE,
     "hint": "LOCAL only — runs on this machine; no key, zero spend",
     "console": "https://ollama.com"},
]

# Tier presets per provider (ADR 0013 revision): saving a provider points the org's
# tiers at it. Embed only moves where the provider can actually embed.
PROVIDER_PRESETS: dict[str, dict[str, str]] = {
    "deepseek": {"reasoning": "deepseek/deepseek-v4-pro", "standard": "deepseek/deepseek-flash",
                 "fast": "deepseek/deepseek-flash"},
    "openai": {"reasoning": "openai/gpt-4o", "standard": "openai/gpt-4o-mini",
               "fast": "openai/gpt-4o-mini", "embed": "openai/text-embedding-3-small"},
    "anthropic": {"reasoning": "anthropic/claude-sonnet", "standard": "anthropic/claude-3-5-haiku",
                  "fast": "anthropic/claude-3-5-haiku"},
    "openrouter": {"reasoning": "openrouter/anthropic/claude-sonnet",
                   "standard": "openrouter/openai/gpt-4o-mini",
                   "fast": "openrouter/openai/gpt-4o-mini"},
    "ollama": {"reasoning": "ollama/llama3.2", "standard": "ollama/llama3.2",
               "fast": "ollama/llama3.2"},
}

PROVIDER_FILE = "provider.json"


def provider_of(model: str) -> str:
    return model.split("/", 1)[0].lower() if "/" in model else "openai"


def secret_name(provider: str) -> str:
    return f"provider:{provider}"


def _headers(provider: str, key: str) -> dict[str, str]:
    if provider == "anthropic":
        return {"x-api-key": key, "anthropic-version": "2023-06-01"}
    return {"Authorization": f"Bearer {key}"}


def normalize_ollama_base(value: str) -> str:
    return (value.strip() or DEFAULT_OLLAMA_BASE).rstrip("/")


async def verify(provider: str, key: str) -> tuple[bool, str]:
    """Try the provider's models endpoint. `ok=False` means THE KEY IS WRONG (401/403);
    network trouble is not the key's fault and is reported as a saved-but-unverified
    answer instead — the caller decides what that difference is worth.

    Local Ollama flips the rule: its server is one loopback hop away, so "cannot
    reach" is deterministic (nothing is running), not flaky — and a saved base URL
    that nothing answers at would be a lie with a menu of failure modes behind it.
    """
    if provider == "ollama":
        base = normalize_ollama_base(key)
        try:
            async with httpx.AsyncClient(timeout=4.0) as client:
                r = await client.get(f"{base}/api/tags")
        except httpx.HTTPError as e:
            return False, (f"couldn't reach Ollama at {base} — is `ollama serve` running? "
                           f"({type(e).__name__})")
        if r.status_code != 200:
            return False, (f"the server at {base} answered {r.status_code} — "
                           "that does not look like Ollama")
        models: list[str] = []
        with contextlib.suppress(Exception):
            models = [m.get("name", "?") for m in (r.json().get("models") or [])]
        if not models:
            return True, f"Ollama is up at {base} — no models pulled yet (`ollama pull` first)"
        return True, f"Ollama is up at {base} — {len(models)} model(s) available"

    endpoint = PROVIDERS[provider][2]
    if endpoint is None:
        return True, "saved; no live check exists for this provider"
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            r = await client.get(endpoint, headers=_headers(provider, key))
    except httpx.HTTPError as e:
        return True, f"saved; couldn't reach the provider to verify ({type(e).__name__})"
    if r.status_code == 200:
        return True, "key verified against the provider"
    if r.status_code in (401, 403):
        return False, "the provider rejected this key"
    return True, f"saved; the provider answered {r.status_code} to the check"


def apply_presets(provider: str) -> dict[str, str]:
    """Point the tiers at the picked provider and remember the choice across restarts.

    A key that is saved but never read by the routing is a dead end, so saving IS
    switching. `data/provider.json` carries the choice; boot re-applies it unless an
    explicit `CREW_TIER_*` env var wins (env beats stored, as everywhere).
    """
    preset = PROVIDER_PRESETS.get(provider, {})
    for name, model in preset.items():
        setattr(settings, f"tier_{name}", model)
    try:
        target = settings.data_path / PROVIDER_FILE
        target.write_text(json.dumps({"provider": provider, "tiers": preset,
                                      "at": datetime.now(UTC).isoformat()}, indent=2),
                          encoding="utf-8")
    except OSError:  # pragma: no cover - unwritable data dir is a bigger problem
        log.warning("could not persist provider choice to %s", PROVIDER_FILE)
    return preset


async def save_provider_key(provider: str, key: str, actor: str = "user") -> dict:
    key = key.strip()
    if provider not in PROVIDERS:
        raise ValueError(f"unknown provider '{provider}'")
    if provider == "ollama":
        key = normalize_ollama_base(key)
    ok, detail = await verify(provider, key)
    if not ok:
        raise PermissionError(detail)
    await vault.create(name=secret_name(provider), value=key, scope_kind="global",
                       scope_id="", actor=actor)
    env_var, field, _ = PROVIDERS[provider]
    os.environ[env_var] = key          # CrewAI / LiteLLM read the env at call time
    setattr(settings, field, key)      # and our own routing sees it immediately
    tiers = apply_presets(provider)
    log.info("provider configured and active: %s", provider)
    return {"provider": provider, "verified": ok, "detail": detail, "tiers": tiers}


async def load_vault_provider_keys() -> list[str]:
    """Boot: bring vault-stored provider keys back to life (env beats vault), then
    re-apply the picker's provider choice unless the env pins the tiers."""
    loaded: list[str] = []
    for provider, (env_var, field, _) in PROVIDERS.items():
        if os.environ.get(env_var) or getattr(settings, field, ""):
            continue
        value = await vault.reveal(secret_name(provider))
        if value:
            os.environ[env_var] = value
            setattr(settings, field, value)
            loaded.append(provider)
    try:
        data = json.loads((settings.data_path / PROVIDER_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    for name, model in (data.get("tiers") or {}).items():
        if os.environ.get(f"CREW_TIER_{name.upper()}"):
            continue  # an explicit env pin wins over the stored choice
        setattr(settings, f"tier_{name}", model)
    return loaded


def state() -> dict:
    """What the first-run card needs: is a provider missing, which one the standard
    tier points at, and the picker's roster with per-provider configured flags."""
    model = settings.tier_standard
    provider = provider_of(model)
    providers = []
    for meta in PROVIDER_META:
        pid = meta["id"]
        if pid not in PROVIDERS:
            continue
        env_var, field, _ = PROVIDERS[pid]
        configured = bool(os.environ.get(env_var) or getattr(settings, field, ""))
        providers.append({**meta, "configured": configured})
    return {
        "needed": (not settings.offline_llm) and (not settings.provider_key_for(model)),
        "provider": provider if provider in PROVIDERS else None,
        "model": model,
        "offline_llm": settings.offline_llm,
        "vault": "configured" if settings.vault_key else "missing",
        "providers": providers,
    }
