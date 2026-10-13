# Tested support matrix

Last verified: 13 October 2026. Crew remains an experimental local application for one trusted shared workspace and one server process. A picker entry or successful credential check is not evidence that a provider completed a project.

## Verified paths

| Host and installation | Provider / model | Evidence | Limits |
|---|---|---|---|
| Windows host, Docker Desktop using Linux containers, isolated Compose installation | Demo; no provider | Fresh isolated installation, actual sandbox command and file-boundary smoke, persistence through recreation, full stopped backup/restore to fresh volumes including vault decryption | Demo agents and deliverables are simulated; sandbox smoke separately checks real tool execution |
| Same Windows / Docker installation | DeepSeek `deepseek/deepseek-flash` | Bounded converter project completed, actual approved command ran 10 tests, four artifacts passed integrity checks; independent 12 formula and 10 invalid-input cases passed; both spending ledgers reconciled | Final success followed eight unsuccessful/partial attempts and implementation repairs, reused source files, and required exact operator approval; aggregate estimated usage US$3.626132 |
| Windows, native Python 3.13 development environment | Deterministic test provider; actual CrewAI harness | Backend suite on 3.13.16: 298 passed, one host-symlink test skipped, one paid test deselected (identical to the 3.12 run before it); six real-harness cases cover model normalization, stop markers and filesystem publication | Automated development checks, not a clean native installation or paid native-provider acceptance |
| Windows / Python 3.12 | Downloaded DeepSeek artifact | Public converter example independently ran all 10 generated tests | Validates the artifact, not a separate provider installation |
| In-app Chromium browser, desktop and 390 px viewport | Local frontend | Provider status, current-run/results scope, room and agent inspection, real animation in the simulated scenario, motion choices and keyboard behavior checked; frontend suite 322 tests; production build passed | Screen-reader, physical touch-device, zoom, large-company profiling and fresh-user usability studies remain; see the UI/UX review |

See [the acceptance record](reviews/2026-10-10/LIVE-ACCEPTANCE.md) and [the reproducible example](../examples/temperature-converter/PROVENANCE.md) for the intervention and cost record. Keys remain in the local encrypted vault; none are included in the example.

## Experimental and unverified paths

| Integration / platform | Current evidence | Required before claiming support |
|---|---|---|
| OpenAI, Anthropic and OpenRouter | Adapter/provider construction and deterministic integration coverage | Real scoped project, artifact tests, accounting and recovery on the advertised installation |
| Ollama | Configuration/model-health logic and adapter coverage | Installed model, real bounded project, tool behavior and zero-rate accounting |
| Native Windows complete installation | Development suite and downloaded artifact execution | Clean installation using only published instructions, with sandbox and provider acceptance |
| Native Linux or macOS; Docker on those hosts | Instructions and CI configuration | Observed clean installation, filesystem controls, sandbox, provider and persistence checks |
| Other models, architectures or provider endpoints | No end-to-end certification | Model-specific compatibility, exact price configuration and the full bounded acceptance workflow |

GitHub-hosted Linux/Windows/Compose workflows were first observed running for this tree on 13 October 2026 (`cba4531`): both Windows legs and the Compose job passed, and the ubuntu backend leg failed on two directory-picker tests that asserted host availability instead of pinning it (`zenity` is absent from the runner; the route answered `supported: false` correctly). That test defect was fixed the same day and reproduced against a simulated pickerless host; the runner has not yet been re-observed, so no Linux support claim is made here. Do not infer host support from the Linux base image alone. Public shared hosting, mutually untrusted tenants, multiple server workers and arbitrary autonomous business operation are outside the current release promise.

When adding a verified row, record the date, commit/build identity, OS/architecture, installation steps, exact model, permissions, actual output checks, cumulative cost, recovery result and required interventions. Preserve unsuccessful attempts rather than reporting only the successful retry.
