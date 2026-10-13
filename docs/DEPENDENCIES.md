# Dependency assessment

Initial assessment: 2026-10-10; upstream advisory status rechecked 2026-10-13, including after the same-day dependency refresh (crewai 1.15.27, fastapi 0.143.0, vite 8, TypeScript 7, recharts 3). Install using `backend/uv.lock` and `frontend/package-lock.json`; avoid treating a range in a manifest as the tested version.

The initial review found no npm audit advisories and four unique Chroma advisories (five scanner records). Those observations apply to the recorded review snapshot, not all future installs. The unused `crewai-tools` dependency was removed, including its extra document-processing dependencies. CrewAI's Anthropic extra and the directly used JSON Schema validator are now declared explicitly.

## Outstanding Chroma advisories

CrewAI 1.15.27 declares `chromadb~=1.5.9`; the lock resolves 1.5.9 (the 1.15.23 → 1.15.27 refresh moved Chroma off 1.1.1). All four advisory pages still list **no patched version** on 13 October 2026, and the advisories were introduced between 0.4.17 and 1.0.0, so every version this lock has resolved — 1.1.1 and now 1.5.9 — is inside an affected range. A routine compatible version bump does not resolve these findings:

- [GHSA-f4j7-r4q5-qw2c](https://github.com/advisories/GHSA-f4j7-r4q5-qw2c): server code injection.
- [GHSA-36p7-vc44-83pf](https://github.com/advisories/GHSA-36p7-vc44-83pf): code injection.
- [GHSA-xph7-9rjv-w5fr](https://github.com/advisories/GHSA-xph7-9rjv-w5fr): authorization scope bypass.
- [GHSA-2wm9-hf6c-p5cr](https://github.com/advisories/GHSA-2wm9-hf6c-p5cr): cross-tenant access.

Crew does not ship a Chroma service or expose its server routes. CrewAI memory is disabled for worker crews; application memory uses SQLite. This limits the demonstrated exposure but **does not fix the vulnerable package** or establish that every transitive code path is unreachable. Do not start a Chroma server from this environment or expose it to untrusted callers.

Removal was tested on 13 October in a disposable, network-disabled copy of the final backend image. An import hook rejected `chromadb` before constructing a memory-disabled crew. CrewAI failed during import: `agent.core` → `base_agent_executor` → `memory.unified_memory` → `rag.embeddings.providers.openai.openai_provider` → `chromadb.utils.embedding_functions.openai_embedding_function`. Thus Chroma is an eager runtime dependency in this CrewAI version, not just an unused lockfile entry. The [uv exclusion mechanism](https://docs.astral.sh/uv/concepts/resolution/#dependency-exclusions) can omit a package but cannot repair these imports. No exclusion, fake module, unsupported override or advisory suppression was applied. A compatible upstream fix or a separately reviewed harness change is needed.

Release follow-up: rerun the advisory scan against the final lockfile; inspect CrewAI's dependency constraints for a compatible fix or removal; test the real harness after upgrading. Keep the finding open until the vulnerable dependency is removed, fixed, or a reviewed and time-bounded exception is approved by the maintainer. Do not silently ignore these advisory IDs to make CI green.

## Repeatable checks

Frontend: `npm ci` then `npm audit --audit-level=high`.

Backend: export the locked runtime dependency inventory with `uv export --frozen --no-dev --no-emit-project --format requirements-txt --output-file requirements-audit.txt`, then scan it with `pip-audit --disable-pip --require-hashes -r requirements-audit.txt`. Dependency resolution/downloads are disabled because the frozen export already lists exact versions; this is an advisory check of that inventory, not verification of installed package bytes. The security workflow keeps the report as an artifact and fails on findings. An audit service outage also requires investigation; it is not a clean scan.

The final inventory audit on 13 October completed with the same **four unique Chroma advisories (five records, including one duplicate)** and no fixed versions reported; the scanner names them `PYSEC-2026-311`, `-3813`, `-3814` and `-3815` (CVE-2026-45829/45831/45833 and the four GHSA ids above). Re-running the documented export + `pip-audit` after the 13 October dependency refresh (crewai 1.15.27, chromadb 1.5.9, 143 dependencies in the frozen inventory) reproduced exactly those five records, still with no fix versions. The frontend audit completed with **zero advisories** on both runs, including after vite 8, TypeScript 7, recharts 3 and vitest 5.0.4. The backend gate remains failing; its finding is not suppressed. An earlier attempt using pip-based hashed collection was stopped after it stalled, then replaced with the inventory-only audit above.

Dependency updates should include lockfiles, focused compatibility checks and the normal test suite. The weekly security workflow and Dependabot configuration make new findings visible; they do not replace review. See [third-party notices](../THIRD_PARTY_NOTICES.md) for redistribution and asset provenance limits.

The separate secret-scanning workflow runs the [official Gitleaks scanner](https://github.com/gitleaks/gitleaks) at an immutable container digest with no container network and a read-only repository mount. Its six ignore entries are exact historical synthetic-fixture fingerprints reviewed in the original evidence log. The six corresponding current fixture lines have explicit test-only `gitleaks:allow` comments. These are not whole-file or credential-pattern exemptions. New findings must be reviewed; do not add a real secret to an exemption. Rotate an exposed real credential before addressing its repository history.
