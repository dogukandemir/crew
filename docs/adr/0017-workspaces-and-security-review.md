# 0017 — Company workspaces, jailed execution, and the security review gate

Status: accepted · Relates to: 0008 (org), 0009 (company layer), 0012 (command desk),
0016 (souls/HR), docs/08 (security), docs/04 (tools)

## Context

Agents could run shell commands, execute Python, read/write files and fetch the web —
with three gaps the owner called out:

1. **Workspaces were anonymous.** Every project's files lived under
   `data/projects/<id>/workspace` — no company chose where its work lives, and the path
   could not be picked at founding.
2. **Execution was not fail-closed.** `shell_run` used a Docker sandbox when Docker was
   available but silently fell back to a host `subprocess` in dev; `python_eval` ran on
   the host interpreter in every mode. A dev machine (no container) meant agent commands
   executed as the user, with only cwd as a fence.
3. **Untrusted content and commands had no gate.** Web results were label-scan only
   (deterministic regexes); commands ran if the capability grant allowed them. There was
   no reviewer, no approval for risky content/commands, no "always allow", and — as the
   owner put it — no evidence trail: "when something goes wrong, we have no evidence to show for it".

## Decision

### 1. Workspaces: one real tree per company (owner's rule)

- `settings.workspace_root` (`CREW_WORKSPACE_ROOT`, default `~/crew/workspace`) — the
  machine-level root; tests override it, never the real home.
- **Founding chooses the company's root.** The wizard's optional *Workspace path* field
  is stored as `company.settings.workspace_root` (absolute path required; created and
  probed at founding — a failure refuses the founding with a clear error). The field has
  a **Browse** button: a browser cannot read absolute paths, so the backend shows the OS
  folder picker on the machine that owns the filesystem (`POST /api/system/pick-directory`,
  Windows Forms / osascript / zenity; loopback-only in prod, one dialog at a time) and the
  choice fills the input. Cancelling changes nothing.
- **Default when not given:** `{workspace_root}/{company_name}/{project_name}` —
  each of the two name segments sanitized for the filesystem (illegal chars removed,
  no traversal, never empty), per the owner's formula.
- Every project under a company **materializes** its workspace at birth:
  `project.settings.workspace = "<company root>/<project folder>"`, directories created,
  `workspace.allocated` written to the audit log. Standalone projects keep the internal
  data-dir workspace (jailed the same way; documented).
- One resolver, `control/workspaces.py`: `project.settings.workspace` → else legacy
  data path. The orchestrator builds `ExecutionRequest.workspace` from it, so
  `ToolContext.workspace` — the fs tools' jail root — is the company folder.

### 2. Execution is fail-closed: no sandbox, no run

- `shell_run` **and** `python_eval` run only inside the Docker container:
  `--network none --read-only --tmpfs /tmp --memory 1g --cpus 1 --pids-limit 256`,
  the project workspace mounted at `/work` and nothing else. No host fallback, ever;
  if Docker is unavailable the tool refuses with an explicit error and a
  `security.sandbox.unavailable` event. (The prod rule already existed; dev now obeys.)
- `python_eval` writes the script into the workspace and runs it **in the same
  container** — the host-interpreter asymmetry found in the tools audit is closed.

### 3. Security review: a reviewer decides, an approval releases

New module `control/security_review.py` — the reviewer the owner asked for.

- **Content (`http_get`, `web_search` results):**
  - deterministic screen: the injection pattern bank (extended: hidden HTML
    instructions, `eval(atob(...))`, credential-bait, download-and-run, fake-authority),
    plus the existing invisible-unicode and fake-role patterns;
  - a **model reviewer** (fast tier) when a provider is configured — it reads the
    content (6 KB cap) + the deterministic hits and returns
    `{risky, reasons, score}`; the content is data, never instructions, and the prompt
    says so. Offline, the deterministic screen decides.
  - verdict `review` → the body is **quarantined** (`data/projects/<id>/quarantine/`,
    sha-named), an approval is filed (`request.kind = "content_review"` with the source,
    the sha, the reasons and a 1.2 KB preview), and the tool returns `approval_required`
    — **the agent never sees unreviewed risky content**. On grant, the retry serves the
    quarantine file (sha-verified) back, marked `released: approved`; a missing file
    falls back to refetch + re-review.
  - clean → returned immediately with a `review: {verdict, method, score}` marker.
- **Commands (`shell_run`, `python_eval` code):** deterministic risk bank (destructive
  delete/format, privilege escalation, persistence, network utilities, obfuscation,
  `curl|sh`, encoded payloads, escapes) decides; the model reviewer (when present) only
  *explains* the risk in the approval note — it never un-flags. Verdict `review` →
  approval (`kind = "command_review"`, with the command, normalization, reasons); the
  command does not run. Grant → retry matches the on-file approval and runs
  (`via: approval`).
- **Always allow (owner's requirement):** the approval UI offers *Always allow*; the
  grant writes a `command_allows` row (normalized command, sample, reason, approver,
  source approval). Later identical commands run directly (`via: allowlist`) with no
  re-query. The list is per project, revocable
  (`DELETE /api/command-allows/{id}`), and every add/revoke is **audited** and emitted.

### 4. Evidence: audit + events for every security action

- Audit actions: `workspace.allocated`, `security.allow.added`,
  `security.allow.removed`, `security.content.released`, `security.content.denied`
  (plus the existing `approval.requested|granted|denied` chain).
- Events (registered): `security.content.reviewed`, `security.content.quarantined`,
  `security.content.released`, `security.command.reviewed`, `security.command.allowed`,
  `security.allow.added`, `security.allow.removed`, `security.sandbox.unavailable`.
- The approval row keeps the full context (command/URL, reasons, preview, sha) — so the
  record answers "what was shown to the human, and what did they decide".

### 5. Egress stays the one door to the internet

`web_search` now checks egress for its DuckDuckGo endpoint too (it was the one caller
that skipped the allowlist); `http_get` keeps allowlist + private-IP block. Shell
containers have no network at all, so all outbound traffic is exactly: provider calls,
and reviewed fetches.

## API surface added

- `POST /api/found` body gains `workspace_path` (optional, absolute).
- `POST /api/approvals/{id}/grant` body gains `always: bool` (command approvals only;
  response carries `allow_id`).
- `GET /api/projects/{id}/command-allows`, `DELETE /api/command-allows/{id}`.

## Consequences

- A company's files are where the owner said they are; agents cannot leave the jail by
  any tool: fs (realpath containment), shell/python (container, workspace-only mount,
  no network), egress (allowlist).
- Approval fatigue is bounded: content reviews fire on risk, command reviews on risk,
  and an owner who says "always allow" stops being asked for that exact command.
- Offline runs remain fully deterministic and honest: the reviewer is the deterministic
  screen, the model only ever adds judgement, never removes the gate.
- Windows dev note: Docker Desktop is required for shell/python tools; without it they
  refuse — which is the point.
