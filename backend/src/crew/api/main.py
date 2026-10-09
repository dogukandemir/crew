"""FastAPI application entrypoint: wiring, lifespan, error mapping."""

from __future__ import annotations

import asyncio
import logging
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from crew import CONTRACT_VERSION, __version__
from crew.api import ws
from crew.api.routes import api
from crew.core.db import init_db
from crew.core.events import bind_loop
from crew.core.models import Skill
from crew.core.settings import settings
from crew.domain.catalog import SKILLS

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s :: %(message)s",
    stream=sys.stdout,
)
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
    # Dev: allow any localhost port — Vite bumps to 5174+ when 5173 is taken and the
    # fixed list would then block every API call ("Cannot reach the backend").
    # Prod keeps the explicit list.
    dev_origin_regex = r"http://(localhost|127\.0\.0\.1):\d+" if settings.is_dev else None
    app.add_middleware(
        CORSMiddleware, allow_origins=settings.cors_list or ["*"], allow_credentials=True,
        allow_origin_regex=dev_origin_regex, allow_methods=["*"], allow_headers=["*"],
    )
    app.include_router(api)
    app.include_router(ws.router)

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
