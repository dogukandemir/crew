"""FastAPI application entrypoint: wiring, lifespan, error mapping."""

from __future__ import annotations

import asyncio
import logging
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware

from crew import CONTRACT_VERSION, __version__
from crew.api import ws
from crew.api.auth import origin_allowed
from crew.api.routes import api, public_api
from crew.core.db import init_db
from crew.core.events import bind_loop
from crew.core.lease import runtime_lease
from crew.core.logging import install_redaction
from crew.core.models import Skill
from crew.core.settings import settings
from crew.domain.catalog import SKILLS

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s :: %(message)s",
    stream=sys.stdout,
)
install_redaction()
log = logging.getLogger("crew")


async def seed_skills() -> int:
    from sqlalchemy import select

    from crew.core.db import session_scope

    added = 0
    async with session_scope() as s:
        existing = {r for r in (await s.scalars(select(Skill.id))).all()}
        for skill in SKILLS:
            if skill.id in existing:
                continue
            s.add(Skill(id=skill.id, label=skill.label, category=skill.category,
                        description=skill.description,
                        typical_tools=[c.value for c in skill.typical_tools],
                        related=list(skill.related)))
            added += 1
    return added


@asynccontextmanager
async def lifespan(app: FastAPI):
    with runtime_lease(settings.data_path):
        bind_loop(asyncio.get_running_loop())
        settings.ensure_dirs()
        await init_db()
        n = await seed_skills()
        log.info("crew %s (contract %s) env=%s auth=%s sandbox=%s offline_llm=%s skills_seeded=%s",
                 __version__, CONTRACT_VERSION, settings.env, settings.auth_mode,
                 settings.tool_sandbox, settings.offline_llm, n)
        log.info("data dir: %s", settings.data_path)
        log.info("model tiers: reasoning=%s standard=%s fast=%s", settings.tier_reasoning,
                 settings.tier_standard, settings.tier_fast)
        from crew.api.routes import _drive
        from crew.control import onboarding
        from crew.control.orchestrator import orchestrator
        from crew.execution.tools import invoker  # noqa: F401  (ensure tool registry imported)

        loaded = await onboarding.load_vault_provider_keys()
        if loaded:
            log.info("provider keys restored from the vault: %s", ", ".join(loaded))
        from crew.core.security import budget, expire_inactive_approvals

        await budget.recover_reservations()
        await expire_inactive_approvals()
        recovered = await orchestrator.recover_interrupted()
        for run_id, project_id in recovered:
            asyncio.create_task(_drive(project_id, run_id))
        if recovered:
            log.info("recovered %d interrupted run(s) after a restart", len(recovered))
        yield
        log.info("crew shutting down")


def create_app() -> FastAPI:
    app = FastAPI(title="Crew", version=__version__, lifespan=lifespan,
                  description="Autonomous agent organization platform. See docs/ for the specification.")
    # Only explicitly configured browser origins may control the local service.
    app.add_middleware(
        CORSMiddleware, allow_origins=settings.cors_list, allow_credentials=True,
        allow_methods=["*"], allow_headers=["*"],
    )
    if settings.auth_mode == "local":
        app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1", "[::1]"])

    @app.middleware("http")
    async def browser_origin_guard(request: Request, call_next):
        if not origin_allowed(request.headers.get("origin")):
            return JSONResponse(status_code=403, content={"detail": "untrusted browser origin"})
        return await call_next(request)

    app.include_router(public_api)
    app.include_router(api)
    app.include_router(ws.router)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request: Request, exc: RequestValidationError) -> JSONResponse:
        # Echoing rejected inputs can disclose keys and makes NaN/Infinity errors
        # fail JSON serialization. Field locations and messages are sufficient.
        errors = [{k: v for k, v in error.items() if k != "input"} for error in exc.errors()]
        return JSONResponse(status_code=422, content={"detail": jsonable_encoder(errors)})

    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled error on %s %s", request.method, request.url.path)
        return JSONResponse(status_code=500, content={
            "type": "about:blank", "title": "internal_error", "status": 500,
            "detail": f"{type(exc).__name__}: {exc}" if settings.is_dev else "internal error",
            "trace_id": request.headers.get("x-request-id", ""),
        })

    @app.get("/")
    async def root() -> dict:
        return {"name": "crew", "version": __version__, "contract": CONTRACT_VERSION,
                "docs": "/docs", "health": "/api/health",
                "spec": "see docs/11-api-and-event-contract.md"}

    return app


app = create_app()


def main() -> None:  # pragma: no cover - process entrypoint
    import uvicorn

    uvicorn.run("crew.api.main:app", host=settings.host, port=settings.port,
                log_level=settings.log_level, reload=settings.is_dev)


if __name__ == "__main__":  # pragma: no cover
    main()
