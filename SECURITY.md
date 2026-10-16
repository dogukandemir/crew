# Security policy

## Supported scope

Crew 0.1 is experimental software for one trusted operator or a trusted team sharing one workspace. Run one backend process. Do not expose local authentication to a LAN or the internet, and do not use this release for mutually untrusted tenants.

The shipped Compose file publishes only loopback ports. Its container-local authentication opt-in is safe only while those mappings stay loopback-only. Native local mode refuses non-loopback listeners. For a remote trusted team, use token mode, a strong signing key, a TLS reverse proxy, and an explicit origin list. Token mode provides shared-workspace roles, not tenant isolation.

## Tool and Docker boundary

File tools check resolved containment and reject link traversal. Agents' file and command operations are serialized per workspace. Shell and Python commands run only in Docker, with network disabled, a read-only root, capability dropping, no-new-privileges, time/output/process/memory/CPU limits, and one writable project folder. External files placed in a project folder become available to that project's agents.

The container distribution's private sandbox broker alone receives the Docker daemon socket. **That broker is trusted with host-level Docker authority.** Its authenticated API accepts only fixed command shapes and a subdirectory of the dedicated workspace volume. It is not a stronger isolation boundary than Docker or its host kernel. Never publish its port or mount its socket/token into an agent container. Keep Docker patched. Native command execution also trusts the local Docker daemon.

URL fetching checks the allowlist on every redirect, rejects private/reserved resolved addresses, pins the validated address for connection, preserves TLS hostname verification, and bounds response size. Pattern-based prompt-injection screening is advisory defense in depth, not a proof of safety.

Approval grants expire and exact invocations are consumed once. An explicit human-created always-allow command rule remains reusable until revoked. Inspect the actual command and project scope before granting one.

## Credentials and privacy

Provider keys are stored using Fernet encryption. The generated master key is stored separately in the data directory; a backup of the encrypted database without that key cannot restore credentials. Arbitrary password strings are not accepted as master keys. OS permissions protect the key; on Windows, also restrict access to the data directory with your account's filesystem permissions.

Secrets known to Crew are redacted from persisted events and formatted logs. Redaction is not a substitute for avoiding secrets in goals, filenames or artifacts. Model context is transmitted to the selected provider; provider policies apply. Local Ollama keeps model requests on the configured server, but enabled web tools still use the internet.

Optional CrewAI/OpenTelemetry/Chroma telemetry is disabled before runtime imports. The frontend keeps login tokens in memory; it does not embed credentials in its build or put them in WebSocket query strings. Reloading requires a new login in token mode.

## Spending and stopping

Caps are application estimates based on configured prices. Unknown failed/interrupted request usage consumes its reserved estimate. A request already sent to a provider may complete after cancellation and still incur charges. Use provider-side billing limits. Interrupted runs pause at startup and require review before resuming.

## Reporting vulnerabilities

Use GitHub's private vulnerability reporting for this repository when enabled: **Security → Advisories → Report a vulnerability**. If private reporting is unavailable, open a minimal issue asking for a private contact without publishing the exploit or secrets. Include affected revision, reproduction steps, expected boundary and impact. Do not test against someone else's deployment.

There is no promised response SLA yet. Track unresolved dependency advisories in [dependency notes](docs/DEPENDENCIES.md); the four open Chroma advisories are a reviewed, version-bounded exception in the dependency workflow (excepted by ID, with the raw scan still preserved as an artifact).

## Full autonomy (YOLO)

A project can turn its human approval gates off in Settings (full autonomy, ADR 0018).
In that mode tool calls, sandbox commands and quarantined web content proceed without asking,
and every call a human would have been asked to approve is written to the hash-chained audit
log and emitted as `policy.yolo`. What does NOT change: capability ceilings by grade,
per-agent tool grants, project deny lists, the workspace jail, the fail-closed sandbox, budget
breakers, reward gating by the verifier, and the redactor. YOLO removes the asking, never the
record; treat a YOLO project as you would a trusted operator standing at the machine.
