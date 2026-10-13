# Crew frontend

React and TypeScript control room for Crew. The backend owns project state, budgets, permissions and execution; the office is a visualization of that state.

## Develop

Use Node 22. From this directory:

```sh
npm ci
npm run dev
```

Start the backend separately using the root [installation guide](../docs/INSTALLATION.md). The development server requires port 5173; it fails rather than silently changing to an origin the API does not trust. Demo needs no credentials.

Set `VITE_API_BASE` only if the backend origin differs from `http://127.0.0.1:8787`. It is compiled into production builds, so rebuild after changing it. Never put API keys or session tokens in Vite environment variables. Token-mode sign-in uses in-memory credentials and server-side revocation; reloading requires sign-in again.

## Check

```sh
npm run typecheck
npm test
npm run build
```

Tests cover state and event projections, component behavior, dialog focus, and session handling. They do not replace browser, screen-reader or real-provider acceptance checks.

## Structure

- `src/api`: typed REST client and application types.
- `src/app`: shell, authentication, query/socket providers and shared animation clock.
- `src/features`: company/project views, agents, office, tasks and deliverables.
- `src/stores`: UI selection, navigation and received event state.
- `src/components`: reusable controls and accessible dialog primitives.

Project panels load on demand. The shared office clock pauses in hidden tabs and respects reduced motion. Task/event lists and deliverable previews provide alternatives to interpreting the animated office.

Use [the current implementation tracker](../docs/reviews/2026-10-10/IMPLEMENTATION.md) for verified release status. Earlier design documents include proposals and must not be treated as proof of implemented capabilities.
