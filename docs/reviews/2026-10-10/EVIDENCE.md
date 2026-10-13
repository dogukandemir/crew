# Crew review: evidence and limitations

**Review date:** 10 October 2026
**Reference commit:** `b447c13a35b57a6757c9bf78242cfd42fddad285`
**Scope:** repository inspection, existing checks, isolated synthetic probes, container/provider-constructor checks, first-run browser inspection, and official-source research.

See [the report](REPORT.md) for implications and [the action plan](ACTION-PLAN.md) for proposed fixes. No application source/configuration changes were made by this review.

This document records the original review only. Implementation was subsequently authorized and completed in multiple passes; current verification is in [IMPLEMENTATION.md](IMPLEMENTATION.md) and [the real-provider acceptance record](LIVE-ACCEPTANCE.md).

## Existing checks

| Check | Result | Interpretation |
|---|---|---|
| Backend `python -m pytest` from `backend` | 202 passed, 1 deselected; about 41.6 seconds | The normal suite excludes live-provider tests |
| Backend `ruff check .` | Passed | Static lint rules passed; not a security proof |
| Frontend `npm test` | 32 files, 284 tests passed | Existing component/unit coverage passed |
| Frontend `npm run build` | Passed | Type/build pipeline works |
| Frontend dependency audit | 0 known vulnerabilities reported | Snapshot of advisory coverage, not absence of risk |
| Python installed-environment audit | 5 records, 4 unique advisories, 1 affected package | Requires dependency reachability/mitigation review |
| Git history secret scan | 6 historical test-fixture matches | No confirmed real credential among those matches |

The backend suite emitted a Starlette/httpx deprecation warning. The frontend build warned about the main chunk exceeding 500 kB: approximately 551.89 kB uncompressed / 159.82 kB gzip. Other significant chunks were charts at 393.22 kB / 109.25 kB gzip and flow at 172.86 kB / 55.04 kB gzip. This suggests lazy loading opportunities; it is not a measured browser-performance failure.

Initial sandboxed checks encountered environment permission/import issues. The affected commands were rerun with the necessary local execution access and passed. Those sandbox failures are not recorded as project regressions.

## Isolated behavior probes

The probes used synthetic projects, users, approvals, credentials, and files in an ignored review-data directory. They did not access another person's data or call a paid provider. The ledger race deliberately synchronized the competing reads to expose a valid interleaving; this demonstrates a concurrency defect, not its natural frequency in production.

| Probe | Observed result | Finding |
|---|---|---|
| File read from workspace to sibling whose name shares the workspace prefix | Read succeeded outside intended root | F01 |
| Development settings with local auth and host `0.0.0.0` | Accepted | F03 |
| Production token settings with an empty configured signing secret | Accepted | F04 |
| Unauthenticated login in token mode | HTTP 401 before login could authenticate | F04 |
| Validly signed viewer token with nonexistent user subject updates project | HTTP 200; update accepted | F04 |
| Two concurrent reservations of 80 against 100 available | Both accepted; ledger 160, stored reserved counter 80 | F05 |
| Reserve twice with the same idempotency key | Second call raised integrity error; counter 20, ledger 10 | F05 |
| Narrative names nonexistent file; no artifacts; judge returns quality 0 / criterion unmet | Final verdict pass, quality 1.0 | F06 |
| Granted file-delete approval expired one day earlier | Still accepted | F09 |
| Two project IDs with the same name in one company | Same allocated workspace path | F11 |

These probes supplement the suite; they were not installed as permanent application regression tests. A local scratch script and redacted scan outputs remain under ignored `data/public-review/` for the working checkout. This committed evidence record contains no real credential values and does not depend on those scratch files for its conclusions. Implementation work should convert the relevant cases into maintained regression tests.

## Docker and provider checks

The backend Docker image built successfully with the repository Dockerfile and installed 151 packages. A network-disabled, disposable container using the image's **default startup command** successfully started the backend. The review container was then stopped.

Directly invoking the virtualenv Python before the default command rebuilt the editable application package failed to import Crew. The default `uv run` startup corrected that and worked. Accordingly, the report does **not** claim that the default image fails to start; it recommends moving this rebuild into image creation for deterministic releases.

The image did not contain a Docker executable. This matters because the application's shell/Python sandbox path expects Docker. The host had Docker available, which does not automatically make it available inside the application image.

Provider constructors were tested inside the fresh image, without network access and using fake keys:

| Provider preset | Constructor result | What this proves |
|---|---|---|
| DeepSeek | OpenAI-compatible implementation constructed | Dependency route exists |
| OpenAI | Native OpenAI implementation constructed | Dependency route exists |
| Anthropic | ImportError requesting the Anthropic extra | Shipped dependency set cannot initialize this preset |
| OpenRouter | OpenAI-compatible implementation constructed | Dependency route exists |
| Ollama | OpenAI-compatible implementation constructed | Dependency route exists |

No successful constructor establishes credential validity, model availability, tool-calling compatibility, cost reporting, or a completed live task. Those remain release tests. In particular, the absence of LiteLLM is not reported as a failure for providers that successfully use the current native/compatible implementations.

## Browser observations

The actual frontend was connected to an isolated offline backend, not the repository mock server. Inspection covered the empty first-run state and founding wizard at desktop size and a 390 × 844 viewport.

- Offline status was not prominently identified as Demo while the interface showed a connected/provider-ready state.
- Quick founding setup hid budget configuration behind detailed setup.
- The dialog fit the narrow viewport; document width stayed at 390 pixels.
- Keyboard focus could move outside the open dialog after tabbing from its final action. The form was not submitted.
- Screenshots in `assets/` capture these states. Existing office/HQ screenshots elsewhere in the repository were examined as historical product assets, not current runtime evidence.

The review did not complete a paid live project through the browser, measure frame rate, run a full accessibility audit, or test the complete office experience on mobile.

## Dependency audit

The installed Python environment was audited with `pip-audit` against `backend/.venv/Lib/site-packages`. The affected package version, `chromadb==1.1.1`, also matched the lockfile and fresh container dependency set. The local application package could not be audited as a published PyPI package and was skipped by that scanner.

The five scanner records corresponded to four unique advisories; one was duplicated through advisory identifiers. The following primary GitHub advisory pages were inspected:

| Advisory | Upstream issue category | Crew-specific interpretation |
|---|---|---|
| [GHSA-f4j7-r4q5-qw2c / CVE-2026-45829](https://github.com/advisories/GHSA-f4j7-r4q5-qw2c) | Pre-authentication code injection | Package present; vulnerable server path not demonstrated in Crew |
| [GHSA-36p7-vc44-83pf / CVE-2026-45833](https://github.com/advisories/GHSA-36p7-vc44-83pf) | Authenticated code injection | Requires reachability/configuration analysis |
| [GHSA-xph7-9rjv-w5fr / CVE-2026-45831](https://github.com/advisories/GHSA-xph7-9rjv-w5fr) | Resource-scoping authorization issue | No Crew Chroma server deployment established |
| [GHSA-2wm9-hf6c-p5cr / CVE-2026-45830](https://github.com/advisories/GHSA-2wm9-hf6c-p5cr) | Tenant authorization issue | No Crew Chroma tenant boundary established |

No fixed version was identified by the audit snapshot. Crew's own memory paths inspected here use SQL and lexical lookup, and the execution configuration disables CrewAI memory. An installed vulnerable dependency is a release risk to triage; it is not by itself evidence that Crew exposes a remotely exploitable endpoint.

Licensing research used [PyMuPDF's official licensing page](https://pymupdf.io/licensing). The package is offered under AGPL or commercial terms. Distribution obligations depend on actual usage/distribution and should be resolved explicitly; the report does not make a legal determination about the overall project.

## Git-history secret scan

Gitleaks scanned all available Git refs with redacted output and a read-only repository mount. It reported 128 commits scanned; Git's repository count was 129. The scan examined approximately 3.94 MB and returned six matches, all in historical backend test fixtures:

- API onboarding/authentication tests in `backend/tests/api/test_api.py`.
- Test configuration in `backend/tests/conftest.py`.
- Security test fixtures in the backend test tree.

The matching values and contexts were inspected and were synthetic JWT/provider-key test inputs, including monkeypatched provider validation. No confirmed live credential was found among these six matches. This does not prove that every possible secret format, untracked file, or external system is free of secrets.

The scan used the official [Gitleaks project](https://github.com/gitleaks/gitleaks) container, digest `sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f`. The mutable image tag was used for discovery; the digest records the image used. Recommended repository controls are documented by [GitHub secret scanning](https://docs.github.com/en/code-security/how-tos/secure-your-secrets/detect-secret-leaks/enable-secret-scanning) and [push protection](https://docs.github.com/en/code-security/concepts/secret-security/push-protection).

## What remains unverified

- Paid/live provider execution, actual billed usage, and a complete real task through every advertised provider.
- End-to-end remote deployment, TLS, browser-origin attack scenarios, or an external penetration test.
- Chroma advisory exploit reachability through the shipped application.
- Full clean-install portability across all OS/architecture combinations.
- Long-duration reliability, event-overflow behavior under load, throughput, and cancellation latency benchmarks.
- Comprehensive accessibility, mobile office behavior, and usability with outside participants.
- GitHub-only settings such as repository visibility, branch protection, security alerts, and release permissions.
- Trademark clearance, final third-party licensing interpretation, and user willingness to adopt or share the product.

The report's competitive and launch recommendations are reasoned product judgments supported by the linked primary project sources, not validated market demand or a prediction of virality.
