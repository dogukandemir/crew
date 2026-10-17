"""The default-deny guarantee docs/08 says the API makes, as a test.

A new router that forgets `require_user` (or an endpoint accidentally moved to `public_api`)
fails HERE instead of shipping unauthenticated.

This file was green and hollow for two rounds: it looped `for route in app.routes`, and this
FastAPI version wraps `include_router()` in an `_IncludedRouter`, so the loop saw one route
(the `/` index) and inspected nothing (16 October finding). The walk is recursive now and the
floor below makes a regression of that kind loud rather than silent.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.routing import APIRoute

# Deliberately reachable without a session: login must work pre-auth; config tells the UI which
# mode to render; health is the liveness probe a container and a stranger's first curl use; `/`
# is the service index.
PUBLIC_PATHS = {
    "/api/auth/login",
    "/api/auth/config",
    "/api/health",
    "/",
}

# The app serves well over a hundred REST routes. A walk that finds a handful has stopped
# reaching into the routers, which is exactly the failure this file exists to catch.
MIN_ROUTES = 100


def _api_routes(app: FastAPI) -> list[APIRoute]:
    """Every APIRoute the app serves, including the ones nested in _IncludedRouter wrappers."""

    def walk(router) -> list[APIRoute]:
        found: list[APIRoute] = []
        for route in getattr(router, "routes", []):
            if isinstance(route, APIRoute):
                found.append(route)
            elif hasattr(route, "original_router"):
                found.extend(walk(route.original_router))
        return found

    return walk(app)


def test_every_rest_route_carries_require_user():
    from crew.api.auth import require_user
    from crew.api.main import create_app

    routes = _api_routes(create_app())
    assert len(routes) >= MIN_ROUTES, f"the walk found only {len(routes)} routes; it is not traversing"
    unguarded: list[str] = []
    for route in routes:
        if route.path in PUBLIC_PATHS:
            continue
        if require_user not in [d.dependency for d in route.dependencies]:
            unguarded.append(f"{sorted(route.methods)} {route.path}")
    assert unguarded == [], f"routes missing require_user: {unguarded}"


def test_the_unauthenticated_surface_is_exactly_the_public_list():
    """A path silently added to, or removed from, the public surface fails here."""
    from crew.api.auth import require_user
    from crew.api.main import create_app

    routes = _api_routes(create_app())
    public = {route.path for route in routes
              if require_user not in [d.dependency for d in route.dependencies]}
    assert public == PUBLIC_PATHS, f"public surface drifted: {sorted(public ^ PUBLIC_PATHS)}"


def test_a_deployment_serves_no_interactive_docs(monkeypatch):
    """The schema enumerates every route and payload: development keeps it, a deployment does not."""
    from crew.api.main import create_app
    from crew.core.settings import settings

    def framework_paths() -> set[str]:
        return {getattr(route, "path", "") or "" for route in create_app().routes}

    monkeypatch.setattr(settings, "env", "prod")
    assert not ({"/docs", "/redoc", "/openapi.json"} & framework_paths())
    monkeypatch.setattr(settings, "env", "dev")
    assert {"/docs", "/redoc", "/openapi.json"} <= framework_paths()
