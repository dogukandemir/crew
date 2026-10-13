# Changelog

## Unreleased — public-readiness work

- Hardened workspace containment, current-policy checks, approval expiry and one-use grants.
- Added serialized spending reservations and a shared model-accounting gateway.
- Verify saved artifact bytes and hashes; distinguish simulated output from Live work.
- Pause interrupted runs for review and account conservatively for unknown model usage.
- Restrict local listeners/browser origins; validate sessions and shared-workspace roles.
- Add explicit Demo/Live controls, visible first-run caps, dialog focus containment and reduced motion.
- Add versioned SQLite migrations, pre-upgrade backups, atomic creation commands and retry receipts.
- Replace the frontend development-server image with static serving and add a private Docker sandbox broker.
- Remove unused `crewai-tools`, add the Anthropic provider dependency and public contribution/security documentation.
- Refresh every declared dependency to its current release: backend lock (crewai 1.15.27, fastapi 0.143.0, starlette 1.8.0, sqlalchemy 2.1.4, ruff 0.17.0, chromadb 1.5.9 via crewai), frontend (vite 8.3.4, TypeScript 7.0.2, recharts 3.10.1, vitest 5.0.4, `@vitejs/plugin-react` 6.1.2), the pinned toolchain (uv 0.13.0 in CI and the backend image) and the workflow actions (checkout v7, setup-node v7, setup-uv v10, upload-artifact v7). The Vite 8 migration moves vendor splitting to `rolldownOptions.output.codeSplitting`, and the recharts 3 tooltip formatter now guards the widened value type — no rendered value is invented.
- Move the tested runtime to Python 3.13 and Node 26. Python 3.13 is the ceiling the pinned CrewAI allows, so `requires-python` is `>=3.13,<3.14` (with a `backend/.python-version`) instead of a range the dependency cannot run on; CI, the backend image and both sandbox images (`SANDBOX_IMAGE` / the broker's worker image) follow. Node 26 (the current active LTS, already the local development line) replaces 22 in CI, the frontend image and the Compose mock. The remaining base images move with it: nginx 1.28 → 1.30 and the sandbox Docker CLI 28 → 29.
- Fix two directory-picker tests that asserted host availability instead of pinning it — the cause of the failing ubuntu CI leg on every run so far; `backend/tests/plugins/no_picker.py` reproduces the pickerless host on any machine.

Verification and outstanding release gates are recorded in the implementation tracker. This entry is not a release certification.
