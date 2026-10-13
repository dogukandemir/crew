# Contributing to Crew

Use Python 3.12 and Node 22. Install locked dependencies with `uv sync --frozen` in `backend` and `npm ci` in `frontend`. Docker is required only when exercising real shell/Python tools or the container distribution. Never commit provider keys, databases, generated workspaces or private deliverables.

## Development loop

Start the backend with `uv run python -m crew serve` and frontend with `npm run dev`. Demo is the default and makes no model requests. Run the relevant checks before opening a pull request:

```sh
# backend directory
uv run ruff check src tests
uv run pytest

# frontend directory
npm run build
npm test
```

The normal test suite excludes tests marked `live`. Those require explicit provider configuration and may cost money; ordinary CI never supplies provider credentials.

Explain the concrete problem, the resulting behavior, and how you checked it. Add a regression test for security boundaries and bugs with a reproducible failure. Keep domain behavior out of the animated renderer: visuals should read real records rather than invent progress. Use the shared model gateway for every provider generation and the tool invoker for side effects.

Database changes need a new migration revision and preservation/rollback tests. API changes need validated request schemas, documented response changes and matching client types. Keep retryable commands idempotent. Review all logs/events for accidental credential capture.

## Issues and roadmap

For bugs, include version/revision, OS, Demo or Live mode, installation method, steps, and a redacted error. For feature proposals, describe the user goal and the smallest useful workflow. Public-readiness work is tracked in `docs/reviews/2026-10-10/IMPLEMENTATION.md`; an implemented item is not verified until its checks pass.

By contributing, you agree that your original contributions use the repository's MIT license. Identify third-party code and asset origins rather than assuming they share that license. Follow [the code of conduct](CODE_OF_CONDUCT.md).
