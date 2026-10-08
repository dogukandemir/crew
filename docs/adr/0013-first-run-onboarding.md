# 0013 — First-run onboarding: one key, stored in the vault

Status: accepted · Relates to: 0008 (security surface), docs/08 (secrets)

## Context

The repository is meant to be cloned by strangers who bring their own provider key. Until
now that meant editing `.env` and restarting — and two quiet traps sat in the way:

1. The vault (docs/08 §3) could store secrets, but nothing in the product ever put one
   there; the vault had no consumer path.
2. The auto-generated `CREW_VAULT_KEY` was **session-only**: every restart minted a fresh
   key, so any stored secret would silently become undecryptable. Harmless while nothing
   was stored; fatal the moment the first provider key lands in it.

## Decision

**One card, one key, on first launch.**

- `GET /api/onboarding/state` — what the card needs to know: `needed` (runner is live and
  the standard tier has no key), `provider`/`model` (the standard tier's target), the
  offline flag, and whether the vault is usable.
- `POST /api/onboarding/key {provider, key}` — the fingerprint of a key is checked against
  the provider's own models endpoint. **401/403 means the key is wrong and the save is
  refused**; network trouble is not the key's fault and saves unverified, replied honestly
  ("couldn't reach the provider to verify"). A stored key is written to the vault as
  `provider:<name>` (Fernet, audit `secret.created`, redactor learned) and applied
  **in-process**: `os.environ` for the CrewAI/LiteLLM layer and the settings object for our
  own routing — effective immediately, no restart, never returned again.
- **Boot:** `load_vault_provider_keys()` restores vault-stored keys into the process (env
  beats vault), so onboarding survives restarts. `get_settings()` now persists its
  auto-generated vault key to `data/vault.key` when `CREW_VAULT_KEY` is unset — the
  session-key orphan trap is closed.
- **UI:** a single overlay card on the welcome screen when `needed` and not skipped: one
  sentence, one input, Save, a link to the provider's console, and a "Skip for now" that
  leaves a quiet re-openable chip. Nothing else — the card asks exactly once.
  Deliberately provider-generic (deepseek/openai/anthropic verified live; others saved
  unverified), while the copy and console link follow the actual standard-tier provider.

## Consequences

- A stranger's happy path is: clone → run → paste a key → create a project. No `.env` edit,
  no restart, no plaintext key on disk outside the encrypted vault (and the local
  `data/vault.key`, which is gitignored with the rest of `data/`).
- The mock backend has no onboarding surface → the card simply never appears there
  (the query fails and stays silent).
- Loopback-only deployments keep working offline: `CREW_OFFLINE_LLM=true` short-circuits
  `needed` to false and the card stays away.
