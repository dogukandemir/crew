# Changelog

## Unreleased: public-readiness work

- **Faster waves**: `CREW_MAX_CONCURRENT_CREWS` now defaults to 4 (was 2), so the
  independent tasks of a plan run four at a time. The second live Launch pack queued its
  four deliverables two at a time; the provider-call gate shares the same number.
- **A cap stops the job, the envelope stops the run**: a refused reservation fails that job
  with `BudgetExceeded`, and an agent's cap or a department envelope running dry no longer
  latches the project. The run pauses only when the project envelope (or its company's) is
  exhausted, and the pause names its numbers and the way out in `run.error` plus a
  `budget.paused` event. A model call costing more than its reservation is booked and
  emitted as `budget.overrun` instead of stopping the project (ADR 0019).
- **The ledger prices what the provider bills**: DeepSeek's rate card now carries its
  prefix-cache hit bucket and its peak/off-peak windows (peak is 01:00-04:00 and 06:00-10:00
  UTC, Monday to Friday, and everything else is half price). The gateway settles on the
  buckets the provider reports, so `llm.response` carries `cached_tokens_in`,
  `reasoning_tokens` and `peak`, and the system status serves the rate card and the window in
  force. Reservations still price the whole input at the peak cache-miss rate. On the
  16 October ledger alone, charging every off-peak call at the peak rate overstated those
  calls by $0.84 of the $2.99 booked; the cache-hit share was not recorded before this and
  sits on top.
- **Thinking mode is a request parameter, and the project sets it on every call**:
  `CREW_REASONING_EFFORT` accepts the provider's whole set (`none` turns thinking off,
  `low`/`high`/`max` set the effort, with `minimal`/`medium`/`xhigh`/`ultra` mapped onto it)
  because the provider's own default is thinking ON at high effort, and the thinking tokens
  bill as output. The planner, the judge and the council's JSON calls run at `none`.
- **A workspace write is a deliverable**: `fs_write` records the file it writes as an
  artifact (byte-exact `sha256`, the producer's attempt stamp), so the verifier reads the
  producer's work. Without it the judge saw "0 registered artifact(s)" and failed tasks
  whose files were on disk.
- **Full autonomy (YOLO)**: a per-project switch in Settings turns every human approval
  gate off. Tools, commands and gated web content run as requested; each call a human
  would have been asked to approve is written to the audit log and emitted as
  `policy.yolo`. Capability ceilings, the workspace jail, the sandbox and budget breakers
  still bind (ADR 0018).
- **The council acts**: a failing-verification council applies its outcome instead of
  parking the task for an operator action that does not exist. Retry requeues with two
  fresh attempts, reduce scope rewrites the acceptance criteria, abort aborts; two
  council life-lines per task, then abort. Verification now reads only the producer's
  final attempt, so earlier drafts stop failing a one-page criterion (ADR 0018).
- Standing tool approvals: "Always allow" on a tool gate writes a revocable, audited
  capability allow for that agent (`capability_allows`, schema revision 4); hard gates
  (`net.post`/`fs.delete`/`git.push`) keep asking every time.
- The task drawer renders weighted required-skill refs (`{skill, weight}`) instead of
  crashing the screen; mock fixtures and wire types aligned.
- Hardened workspace containment, current-policy checks, approval expiry and one-use grants.
- Added serialized spending reservations and a shared model-accounting gateway.
- Verify saved artifact bytes and hashes; distinguish simulated output from Live work.
- Pause interrupted runs for review and account conservatively for unknown model usage.
- Restrict local listeners/browser origins; validate sessions and shared-workspace roles.
- Add explicit Demo/Live controls, visible first-run caps, dialog focus containment and reduced motion.
- Add versioned SQLite migrations, pre-upgrade backups, atomic creation commands and retry receipts.
- Replace the frontend development-server image with static serving and add a private Docker sandbox broker.
- Remove unused `crewai-tools`, add the Anthropic provider dependency and public contribution/security documentation.
- Refresh every declared dependency to its current release: backend lock (crewai 1.15.27, fastapi 0.143.0, starlette 1.8.0, sqlalchemy 2.1.4, ruff 0.17.0, chromadb 1.5.9 via crewai), frontend (vite 8.3.4, TypeScript 7.0.2, recharts 3.10.1, vitest 5.0.4, `@vitejs/plugin-react` 6.1.2), the pinned toolchain (uv 0.13.0 in CI and the backend image) and the workflow actions (checkout v7, setup-node v7, setup-uv v10, upload-artifact v7). The Vite 8 migration moves vendor splitting to `rolldownOptions.output.codeSplitting`, and the recharts 3 tooltip formatter now guards the widened value type, no rendered value is invented.
- Move the tested runtime to Python 3.13 and Node 26. Python 3.13 is the ceiling the pinned CrewAI allows, so `requires-python` is `>=3.13,<3.14` (with a `backend/.python-version`) instead of a range the dependency cannot run on; CI, the backend image and both sandbox images (`SANDBOX_IMAGE` / the broker's worker image) follow. Node 26 (the current active LTS, already the local development line) replaces 22 in CI, the frontend image and the Compose mock. The remaining base images move with it: nginx 1.28 → 1.30 and the sandbox Docker CLI 28 → 29.
- Fix two directory-picker tests that asserted host availability instead of pinning it, the cause of the failing ubuntu CI leg on every run so far; `backend/tests/plugins/no_picker.py` reproduces the pickerless host on any machine.
- Stop the dependency workflow from being red by construction: the four open Chroma advisories are now a reviewed exception listed by ID, the gated audit still fails on any other finding, a guard expires the exception the moment the locked inventory stops pinning `chromadb==1.5.9`, and the raw unfiltered scan is preserved as an artifact beside the gated one.
- Hold the promises an end-to-end review found broken (14 Oct 2026): the command desk enforces the same budget ceilings as `PATCH /projects/{id}` and the audit view is project-scoped (the whole chain stays behind admin at `GET /api/audit`); admin gating sits on the routes themselves; brain/task/hire writes refuse foreign ids; the command review gates python and inline destruction; the vault refuses cross-scope overwrites, audits every lease and re-learns stored secrets into the redactor on boot; approvals honour the caller's `ttl_minutes`; pagination takes `ge=1` bounds; login/run/command rate limits exist; the WS handshake accepts `?token=` and `Authorization`; dev CORS allows any loopback port; every response carries `X-Crew-Contract`; and `tests/security/test_routes_guarded.py` finally enforces the documented default-deny. Frontend: the leaderboard join is fixed (the roster's Success column and the Rewards drawer work again), one zero-success rule shows `n/a` instead of a fabricated 0%, one grade map matches the backend enum, artifact rows keep a single interactive element, and money/time formatting is unified. The docs sweep brings docs/01–13 back in line with the as-built system.

Verification and outstanding release gates are recorded in the implementation tracker. This entry is not a release certification.
