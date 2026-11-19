# Releasing Crew

One version number lives in three places and must agree everywhere:

- `backend/src/crew/__init__.py` (`__version__`)
- `backend/pyproject.toml` (`version`)
- `frontend/package.json` (`version`)

`GET /api/health` serves that value, so a mismatch is visible to every client.

## Cutting a release

1. **Changelog first.** Open a `## vX.Y.Z — <date>` section at the top of `CHANGELOG.md` and move
   the finished work under it. Do not leave an "Unreleased" section above a dated one: that reads
   as a timeline running backwards.
2. **Bump the three sources.** A version-only change needs no `uv lock`; run it only when
   dependencies changed.
3. **Run the gates locally — the same commands CI runs:**
   ```sh
   cd backend && uv run ruff check . && uv run pytest
   cd frontend && npx tsc --noEmit && npx vitest run && npm run build
   docker compose config --quiet
   CREW_JWT_SECRET=$(python -c "import secrets; print(secrets.token_urlsafe(48))") \
   CREW_CORS_ORIGINS=https://crew.example.com \
   CREW_PUBLIC_ORIGIN=https://crew.example.com \
   docker compose -f docker-compose.prod.yml config --quiet
   ```
4. **Commit, push, wait for green CI.** A red badge on release day is the one thing a stranger
   checks first.
5. **Tag and publish:**
   ```sh
   git tag -a vX.Y.Z -m "Crew vX.Y.Z"
   git push origin vX.Y.Z
   ```
   The `Release` workflow verifies that the tag matches all three version sources, reruns
   both gates and the Compose render, extracts the matching CHANGELOG section and creates
   the GitHub Release with it. Do not run `gh release create` by hand: a release the
   workflow did not verify is a claim without evidence. If verification fails, fix the
   cause, delete the pushed tag (`git push origin :vX.Y.Z`), and tag the corrected commit.
   Re-derive the counts quoted in SUPPORT-MATRIX and README from the suite itself
   (`uv run pytest --collect-only`, `npx vitest run`) — a number is true for one commit only.
6. **Post-release:** the Pages site under `site/` deploys on the next push that touches it. If the
   site did not change, run `gh workflow run pages.yml` explicitly, then verify
   <https://dogukandemir.github.io/crew/> and the social card.

## The first public release (one-time flip)

These steps only work after the repository is public; private repositories answer 404 for the
three security settings and skip the Pages workflow.

```sh
gh repo edit dogukandemir/crew --visibility public --accept-visibility-change-consequences
gh workflow run pages.yml
gh api -X PUT repos/dogukandemir/crew/private-vulnerability-reporting
gh api -X PATCH repos/dogukandemir/crew/code-scanning/default-setup -f state=configured
gh api -X PUT repos/dogukandemir/crew/automated-security-fixes
```

Then, still outside the API:

- Upload the social preview (`site/assets/social-preview.png`, 1280×640) in the repository
  settings; GitHub has no API for it.
- Check the rendered README on GitHub (tables, the screenshots row, the anchors in the FAQ link).
- Re-run the external URL checks a stranger would: the site root, `/robots.txt`, `/sitemap.xml`,
  `/llms.txt`.

## What a release is not

CI green and a tag do not certify maturity. The open evidence — provider acceptance, platform
coverage, accessibility, the Chroma advisories — is tracked in
[SUPPORT-MATRIX.md](SUPPORT-MATRIX.md) and [DEPENDENCIES.md](DEPENDENCIES.md), and release notes
should point there rather than imply more than was proven.
