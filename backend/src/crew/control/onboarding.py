"""First-run onboarding (ADR 0013): the user pastes a provider key once.

The key is verified against the provider, stored ENCRYPTED in the vault (never in
plaintext, never returned again), and made effective in-process — `os.environ` for the
CrewAI/LiteLLM layer, the settings object for our own routing — so nothing needs a
`.env` edit or a restart. On boot, stored keys are loaded back, so onboarding survives.
"""

from __future__ import annotations

import logging
import os

import httpx

from crew.core.security import vault
from crew.core.settings import settings

log = logging.getLogger(__name__)

# provider → (env var the runner reads, settings field, verification endpoint or None)
PROVIDERS: dict[str, tuple[str, str, str | None]] = {
    "deepseek": ("DEEPSEEK_API_KEY", "deepseek_api_key", "https://api.deepseek.com/models"),
    "openai": ("OPENAI_API_KEY", "openai_api_key", "https://api.openai.com/v1/models"),
    "anthropic": ("ANTHROPIC_API_KEY", "anthropic_api_key",
                  "https://api.anthropic.com/v1/models"),
    "gemini": ("GEMINI_API_KEY", "gemini_api_key", None),
    "openrouter": ("OPENROUTER_API_KEY", "openrouter_api_key", None),
}


def provider_of(model: str) -> str:
    return model.split("/", 1)[0].lower() if "/" in model else "openai"


def secret_name(provider: str) -> str:
    return f"provider:{provider}"


def _headers(provider: str, key: str) -> dict[str, str]:
    if provider == "anthropic":
        return {"x-api-key": key, "anthropic-version": "2023-06-01"}
    return {"Authorization": f"Bearer {key}"}


async def verify(provider: str, key: str) -> tuple[bool, str]:
    """Try the provider's models endpoint. `ok=False` means THE KEY IS WRONG (401/403);
    network trouble is not the key's fault and is reported as a saved-but-unverified
    answer instead — the caller decides what that difference is worth."""
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


async def save_provider_key(provider: str, key: str, actor: str = "user") -> dict:
    key = key.strip()
    if provider not in PROVIDERS:
        raise ValueError(f"unknown provider '{provider}'")
    ok, detail = await verify(provider, key)
    if not ok:
        raise PermissionError(detail)
    await vault.create(name=secret_name(provider), value=key, scope_kind="global",
                       scope_id="", actor=actor)
    env_var, field, _ = PROVIDERS[provider]
    os.environ[env_var] = key          # CrewAI / LiteLLM read the env at call time
    setattr(settings, field, key)      # and our own routing sees it immediately
    log.info("provider key stored in the vault: %s", provider)
    return {"provider": provider, "verified": ok, "detail": detail}


async def load_vault_provider_keys() -> list[str]:
    """Boot: bring vault-stored provider keys back to life (env beats vault)."""
    loaded: list[str] = []
    for provider, (env_var, field, _) in PROVIDERS.items():
        if os.environ.get(env_var) or getattr(settings, field, ""):
            continue
        value = await vault.reveal(secret_name(provider))
        if value:
            os.environ[env_var] = value
            setattr(settings, field, value)
            loaded.append(provider)
    return loaded


def state() -> dict:
    """What the first-run card needs: is a key missing, for which model, and can the
    vault hold one."""
    model = settings.tier_standard
    provider = provider_of(model)
    return {
        "needed": (not settings.offline_llm) and (not settings.provider_key_for(model)),
        "provider": provider if provider in PROVIDERS else None,
        "model": model,
        "offline_llm": settings.offline_llm,
        "vault": "configured" if settings.vault_key else "missing",
    }
