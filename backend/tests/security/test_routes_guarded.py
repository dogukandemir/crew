"""The default-deny guarantee docs/08 §2 promises, as a test.

A new router that forgets `require_user` (or an endpoint accidentally moved to
`public_api`) fails HERE instead of shipping unauthenticated. This guard was documented
since the beginning but the file never existed (review 2026-10-14, finding F-07).
"""

from __future__ import annotations

from fastapi.routing import APIRoute

# Deliberately reachable without a session: login must work pre-auth; config tells the
# UI which auth mode to render; the rest are framework plumbing.
PUBLIC_PATHS = {
    "/api/auth/login",
    "/api/auth/config",
    "/api/health",
    "/",
    "/docs",
    "/docs/oauth2-redirect",
    "/openapi.json",
    "/redoc",
}


def test_every_rest_route_carries_require_user():
    from crew.api.auth import require_user
    from crew.api.main import create_app

    app = create_app()
    unguarded: list[str] = []
    for route in app.routes:
        if not isinstance(route, APIRoute) or route.path in PUBLIC_PATHS:
            continue
        deps = [d.dependency for d in route.dependencies]
        if require_user not in deps:
            unguarded.append(f"{sorted(route.methods)} {route.path}")
    assert unguarded == [], f"routes missing require_user: {unguarded}"
