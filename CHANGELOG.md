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

Verification and outstanding release gates are recorded in the implementation tracker. This entry is not a release certification.
