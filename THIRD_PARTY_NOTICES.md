# Third-party notices and asset provenance

Crew's application code is distributed under the root MIT license. Installed dependencies retain their own copyrights, licenses and notices; the root license does not relicense them. The backend and frontend lockfiles identify the exact resolved packages. Container distributions also include Python, Node build tooling, nginx, Docker CLI and operating-system packages under their respective terms.

Before publishing a binary or container release, collect the license texts and inventory from that exact build and include the notices required by those packages. This document is a provenance ledger, not a completed license clearance or exhaustive dependency notice bundle.

| Asset | Repository evidence | Release status |
|---|---|---|
| `frontend/src/features/sprites/atlas.png` and `atlas.gen.ts` | The manifest describes an in-house deterministic pixel-art generator. The maintainer confirmed on 11 October 2026 that this artwork was created programmatically and is owned by them. | Ownership confirmed by maintainer; retain the generator/source record with future artwork changes. |
| `frontend/public/favicon.svg` | Repository vector asset. | Maintainer confirmed original programmatic creation and ownership on 11 October 2026. |
| `docs/assets/*.png` | Product screenshots already in the repository. | Maintainer confirmed artwork/screenshot ownership on 11 October 2026. Inspect displayed names/content before public promotion. |
| `docs/reviews/2026-10-10/assets/*` | Screenshots captured for the local review. | Inspect for private names/content before publishing the review directory. |

Do not infer ownership merely because a file is checked into Git. Contributors should include the origin, license, attribution requirements and any source files for new third-party media. New assets with unknown provenance remain a release issue; do not invent an attribution or license.
