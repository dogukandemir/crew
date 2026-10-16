# Crew: prioritized action plan

**Date:** 10 October 2026
**Baseline:** `b447c13a35b57a6757c9bf78242cfd42fddad285`
**Related:** [full findings](REPORT.md) · [review evidence](EVIDENCE.md)

This is a proposed implementation plan, not a record of completed fixes. It is organized around release gates rather than additional features. Scope: a local-first, single-operator product that uses real agents to complete bounded projects through a game-like interface. Shared hosting is a separate, later commitment.

**Update, 13 October:** This original plan is preserved for comparison. Use [IMPLEMENTATION.md](IMPLEMENTATION.md) for current completion and remaining work, and [LIVE-ACCEPTANCE.md](LIVE-ACCEPTANCE.md) for the passed DeepSeek project. Immediate next gates are Chroma remediation, binary notices, remaining transactional/load review, observed remote CI/clean installation and a pilot; the original unchecked checklist below is not a current status dashboard.

## 1. Priority order

| Order | Work package | Findings | Primary owner | Required result |
|---|---|---|---|---|
| 1 | File containment and tool policy | F01–F02 | Backend/security | Every tool acts within current project authority |
| 2 | Safe distribution and honest mode labels | F03, F12, F17 | Backend/frontend | Local demo cannot accidentally present itself as a remote-ready live service |
| 3 | Authentication and approval integrity | F04, F09 | Backend/security | Actors and grants have enforced, bounded authority |
| 4 | Atomic budgets and complete usage coverage | F05 | Backend/runtime | Every billable model call is governed and reconciled |
| 5 | Artifact-backed verification | F06 | Runtime/product | Success means a deliverable passed explicit checks |
| 6 | Cancellation, recovery, and workspace durability | F07, F11, F13 | Backend/runtime | Work can stop, resume/recover, and survive restart safely |
| 7 | Egress, secrets, and dependency cleanup | F08, F10, F16 | Backend/security | Data/network boundaries are enforced and disclosed |
| 8 | Scheduler and event correctness | F14–F15, F19 | Backend/platform | Bounded concurrency, reliable state, recoverable event delivery |
| 9 | Supported installation and provider matrix | F12, F20 | Platform | A clean machine can complete the documented live workflow |
| 10 | Accessible onboarding and flagship demo | F17–F18 | Product/frontend | New users understand and complete their first project |
| 11 | Public repository and launch assets | F20 | Maintainer/product | Contributors and users know what is supported and how to participate |

Work can overlap, but presentation and promotion must not get ahead of the enforcement and live-work gates. Shared-host authentication can be deferred only if that deployment mode is explicitly unsupported and technically rejected.

## 2. Gate A: immediate containment and truthful publication

**Goal:** a repository that can be shared as an experimental local project without known basic containment failures or misleading setup claims.

### A1. Enforce workspace boundaries

- Replace the string-prefix path test with path-aware containment.
- Reject destructive operations on the workspace root.
- Allocate paths using immutable project IDs; support duplicate display names without shared files.
- Keep file access inside a constrained execution boundary where feasible; define symlink handling explicitly.

**Acceptance:** regression cases cover sibling-prefix paths, `..`, absolute paths, symlinks, root deletion, and duplicate/renamed projects. A runner integration test proves that one project cannot read, write, or delete another project's files. Run supported path cases on Windows and Linux.

### A2. Make current policy unavoidable

- Require project/run/agent identity in every tool invocation.
- Resolve authoritative policy at execution time, not only at task construction.
- Enforce pause, deny rules, approval requirements, and current run state before acting.
- Persist a policy decision that identifies which rule allowed or denied an action.

**Acceptance:** changing a project's policy while a task is active blocks its next forbidden tool call. Missing project context fails closed. Tests invoke the actual runner/tool adapter, not just the policy helper.

### A3. Make local deployment safe by default

- Bind published demo/API ports to host loopback.
- Reject nonlocal use of local-auth mode; define trusted origins/hosts and local bootstrap credentials.
- Make Demo/Live status persistent and unmistakable in the UI.
- Correct README setup steps and claims immediately, even before larger runtime fixes land.
- Document the supported operating envelope and a private security-reporting route.

**Acceptance:** a fresh default installation is inaccessible through non-loopback interfaces under the tested host configuration; an unsafe configuration is rejected with a useful error. A demo user can identify simulation mode without opening settings. Documentation describes current behavior, including unavailable live capabilities.

### A4. Complete the publication hygiene review

- Triage the four unique Chroma advisories for actual reachability; remove unused dependency surfaces where possible.
- Review third-party license and artwork provenance obligations.
- Add secret scanning and dependency review to CI; handle known synthetic fixtures narrowly.
- Add `.dockerignore` files and ensure built images contain no local `.env` or unrelated host files.

**Acceptance:** dependency decisions and notices are documented; CI alerts are actionable; the clean release build contains only intended files. Do not advertise this gate as a security certification.

## 3. Gate B: trustworthy live execution

**Goal:** a small project produces verified artifacts with enforceable controls.

### B1. Centralize and reconcile model spending

- Introduce a model gateway used by workers, planners, judges, councils, and retries.
- Reserve against every applicable hierarchy level in one atomic transaction.
- Make reservation/settlement idempotent; reconcile interrupted calls and distinguish unknown usage.
- Define daily/windowed limits and reset behavior; limit model output before making a request.

**Acceptance:** concurrent calls cannot collectively reserve more than the available budget. Repeated idempotency keys do not change totals. Simulated timeout, provider error, restart, and late usage reporting leave ledger and counters consistent. Tests cover company/department/project/agent limits and date boundaries. Explain unavoidable provider-billing uncertainty in the UI.

### B2. Make deliverables prove success

- Give the first supported template explicit, machine-checkable acceptance criteria.
- Register actual artifacts with paths, hashes, producing task IDs, and verification results.
- Require mandatory checks to pass; a negative check cannot be overridden by keyword overlap.
- Treat missing evidence or unavailable verification as a separate outcome.

**Acceptance:** nonexistent files, empty artifacts, stale artifacts from another task, failing builds, and a rejecting mandatory judge/check cannot earn success or rewards. A real successful task exposes its files and the checks that passed. Include an adversarial regression for the imaginary-file case reproduced in this review.

### B3. Implement stop and recovery semantics

- Define supported lifecycle transitions and terminal states.
- Add cancellable workers, tracked container IDs, bounded cleanup, and cancellation checks at tool/model boundaries.
- Separate “stop scheduling” from “terminate active work” in behavior and UI language.
- Reconcile reservations, task leases, and partially produced artifacts on startup.
- Persist workspaces and add versioned database migrations.

**Acceptance:** cancelling a long-running isolated command ends its container within a declared bound. No new tools run after cancellation acknowledgement. Terminal runs cannot later become successful through a stale worker callback. Restart midway through work leaves no silent reservation leak and preserves artifact files. Fresh install, upgrade, backup, and restore are tested.

### B4. Close remaining trust boundaries

- Fix login bootstrap, active-user lookup, roles, ownership, and signing-secret validation if token mode remains offered.
- Bind approvals to scope/arguments/expiry and distinguish one-shot from reusable grants.
- Enforce egress policy on every redirect and resolved destination.
- Centralize redaction and register secrets on startup; specify telemetry/privacy defaults.

**Acceptance:** viewers cannot mutate projects or approve work; disabled users lose access; expired/revoked grants fail; command changes invalidate approval; redirect/private-IP cases are denied before connection; test secrets never appear in events, logs, or exports before or after restart.

## 4. Gate C: reproducible installation and first value

**Goal:** someone outside the project can succeed from the documentation.

### C1. Publish a deliberately small support matrix

Start with one cloud provider plus Demo. Add Ollama and other providers after their complete flows pass. Separate supported, experimental, and planned integrations.

For every supported row, record OS/architecture, install method, provider/model, sandbox prerequisites, last test date, and known restrictions. Do not interpret a successful provider constructor or model-list response as a successful task execution.

### C2. Finish the distribution

- Choose and implement a supported execution-worker arrangement for Docker users.
- Persist both application data and workspaces.
- Install required provider extras; test keyless Ollama configuration separately.
- Make Demo-to-Live transitions explicit and refresh runtime configuration reliably.
- Produce immutable release images with a built frontend and startup that does not rebuild application dependencies.
- Add a diagnostic command/screen for provider access, available model, workspace access, sandbox health, and limits.

**Acceptance:** from a clean machine or disposable VM, follow only the README and deliver the flagship artifact. Repeat on each claimed platform. Include upgrade and uninstall/data-retention instructions. A missing prerequisite produces one clear explanation and a corrective action.

### C3. Simplify and make onboarding accessible

- Offer one primary first action and a clear Demo/Live choice.
- Show goal, acceptance criteria, provider, workspace, budget, and permissions before starting.
- Make the completed result and verification evidence the next obvious destination.
- Implement accessible dialog focus/labels, keyboard navigation, reduced motion, and a non-canvas work view.
- Lazy-load heavy views; measure initial load and interaction responsiveness.

**Acceptance:** keyboard-only users complete the wizard without focus escaping the modal. Test narrow screens and zoom. In a small observed usability study, users correctly identify whether work is simulated, what it can cost, how to stop it, and where to find the result.

## 5. Gate D: public launch and contributor experience

**Goal:** a credible, reproducible public story supported by a maintainable repository.

- Add `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue/PR templates, release notes, and ownership/review guidance.
- Keep architecture docs aligned with implementation; explain the role of CrewAI and known limitations.
- Decide naming/descriptor and asset licensing before producing the final launch kit.
- Publish a short real-work recording, an example repository/task, an artifact result card, and clean screenshots.
- Invite a small pilot group to reproduce the same first task; track failure points and fix the largest ones.
- Set a realistic issue-response policy and identify approachable contributor tasks.

**Acceptance:** an outside tester can install, run, inspect results, and report a problem without a private walkthrough. The demo is reproducible and distinguishes simulations, estimated cost, and actual evidence. All launch claims have a corresponding test, supported behavior, or clearly stated limitation.

## 6. Suggested sequencing and effort

These are planning ranges, not commitments. They assume one experienced engineer familiar with Python/TypeScript, part-time product/design support, and no expansion into multi-tenant hosting. Investigation, regressions, provider behavior, and the chosen sandbox arrangement can change the estimate substantially.

| Phase | Approximate engineering effort | Exit |
|---|---:|---|
| Immediate containment and documentation correction | 4–7 engineer-days | Gate A core controls |
| Budgets, verification, lifecycle, durable workspaces | 12–20 engineer-days | Gate B runtime contracts |
| Authentication/egress/secrets/dependency hardening | 6–10 engineer-days | Gate B trust boundaries |
| Distribution, provider support, migrations, event reliability | 8–14 engineer-days | Gate C technical path |
| Onboarding, accessibility, pilot, repository and launch assets | 7–12 engineer-days | Gates C–D user path |
| **Indicative total** | **37–63 engineer-days** | Narrow, credible public alpha |

Some work overlaps across phases; the ranges are deliberately approximate. A single engineer should think in roughly eight to thirteen working weeks rather than a weekend polishing pass. A small team can shorten elapsed time, but shared interfaces and integration testing still constrain parallel work.

If capacity is limited, reduce scope before weakening controls: one provider, one workflow, one operator, one supported deployment, and one excellent demo. Defer mobile office completeness, multi-user hosting, marketplace integrations, richer character systems, and additional autonomous departments.

## 7. Release checklist

The broad public launch remains gated until all applicable items have evidence:

- [ ] File containment and project policy integration regressions pass.
- [ ] Default install is local-only; remote mode is either secured/tested or explicitly rejected.
- [ ] Approvals expire and bind to the intended action; role boundaries are enforced where offered.
- [ ] Every model-call path participates in atomic budget and usage accounting.
- [ ] A real artifact, not narrative alone, is required for success and rewards.
- [ ] Stop/cancel behavior matches its UI promise and cleans up worker resources.
- [ ] Restart/upgrade preserves files and reconciles outstanding work and money.
- [ ] Egress and secret-redaction regressions pass.
- [ ] Dependency advisories and license obligations have documented decisions.
- [ ] Each advertised provider and deployment method completes a clean-install live task.
- [ ] Demo/Live, permissions, budget, and results are clear to first-time users.
- [ ] Keyboard/dialog behavior and the supported viewport range are tested.
- [ ] README claims, screenshots, security policy, contribution guide, and release notes match the release.

## 8. Decisions to make during implementation

Recommended defaults, unless the product owner chooses otherwise:

| Decision | Recommended starting point | Reason |
|---|---|---|
| Initial user | Indie builders and agent developers | Likely to understand local setup and give actionable feedback |
| Deployment promise | Local-first, one operator | Smallest credible security and support surface |
| First real task | Bounded software artifact with an automated acceptance check | Demonstrates useful work and makes verification objective |
| Harness strategy | CrewAI adapter behind a stable Crew-owned contract | Preserves existing investment and allows later alternatives |
| Growth mechanism | Reproducible result and redacted replay sharing | Connects the visual hook to real utility |
| Branding | Distinctive descriptor now; decide rename before launch assets | Reduces confusion with the underlying framework |

No additional product features are needed to start these corrections. The next implementation task should be F01 and F02, followed immediately by the safe default distribution changes in F03.
