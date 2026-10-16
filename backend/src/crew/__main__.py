"""Crew command line: serve, db, seed, auth, audit, brains."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys

from crew import CONTRACT_VERSION, __version__


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="crew", description="Crew: autonomous agent organization platform")
    p.add_argument("--version", action="version", version=f"crew {__version__} (contract {CONTRACT_VERSION})")
    sub = p.add_subparsers(dest="cmd")

    serve = sub.add_parser("serve", help="run the API server")
    serve.add_argument("--host", default=None)
    serve.add_argument("--port", type=int, default=None)
    serve.add_argument("--reload", action="store_true")

    dbi = sub.add_parser("db", help="database maintenance")
    dbi.add_argument("action", choices=["init", "seed", "drop"])

    a = sub.add_parser("auth", help="user management")
    a.add_argument("action", choices=["create-user"])
    a.add_argument("--email")
    a.add_argument("--name", default="")
    a.add_argument("--password")
    a.add_argument("--role", default="admin")

    aud = sub.add_parser("audit", help="audit trail")
    aud.add_argument("action", choices=["verify"])

    br = sub.add_parser("brains", help="memory maintenance")
    br.add_argument("action", choices=["list", "search"])
    br.add_argument("--project")
    br.add_argument("--query", default="")

    orc = sub.add_parser("run", help="run a goal headlessly")
    orc.add_argument("--project", required=True)
    orc.add_argument("--goal", required=True)

    sub.add_parser("status", help="print runtime status")
    sub.add_parser("doctor", help="check local installation without making model requests")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.cmd == "serve":
        import uvicorn

        from crew.core.settings import settings

        host = args.host or settings.host
        if settings.auth_mode == "local" and host not in ("127.0.0.1", "localhost", "::1") and not settings.container_local_auth:
            raise ValueError("local authentication requires a loopback listener")
        uvicorn.run("crew.api.main:app", host=host, port=args.port or settings.port,
                    reload=args.reload, log_level=settings.log_level)
        return 0
    if args.cmd == "db":
        return asyncio.run(_db(args.action))
    if args.cmd == "auth":
        return asyncio.run(_auth(args))
    if args.cmd == "audit":
        return _print(asyncio.run(_audit()))
    if args.cmd == "brains":
        return asyncio.run(_brains(args))
    if args.cmd == "run":
        from crew.core.lease import runtime_lease
        from crew.core.settings import settings

        with runtime_lease(settings.data_path):
            return asyncio.run(_run(args))
    if args.cmd == "doctor":
        return asyncio.run(_doctor())
    if args.cmd == "status":
        return asyncio.run(_status())
    build_parser().print_help()
    return 0


def _print(obj) -> int:
    print(json.dumps(obj, indent=2, default=str))
    return 0


async def _db(action: str) -> int:
    from crew.api.main import seed_skills
    from crew.core.db import drop_db, init_db

    if action == "init":
        await init_db(create_all=True)
    elif action == "seed":
        await init_db(create_all=True)
        print(f"skills seeded: {await seed_skills()}")
        return 0
    elif action == "drop":
        await drop_db()
    print(f"db: {action} done")
    return 0


async def _auth(args) -> int:
    from crew.api.auth import create_user

    if not args.email:
        print("--email is required", file=sys.stderr)
        return 2
    if not args.password:
        from getpass import getpass
        args.password = getpass("Password: ")
    if len(args.password) < 12:
        print("Use a password of at least 12 characters", file=sys.stderr)
        return 2
    from crew.core.db import init_db
    await init_db()
    return _print(await create_user(email=args.email, name=args.name or args.email,
                                    password=args.password, role=args.role))


async def _audit() -> dict:
    from crew.core.security import verify_audit_chain

    return await verify_audit_chain()


async def _brains(args) -> int:
    from crew.core.brains import brain_service

    if args.action == "list":
        return _print(await brain_service.list_brains(args.project))
    hits = await brain_service.search(project_id=args.project, brain_ids=None, query=args.query, top_k=10)
    return _print(hits)


async def _run(args) -> int:
    import asyncio as _a

    import crew.core.events as ev
    from crew.control.orchestrator import orchestrator
    from crew.core.db import init_db

    ev.bind_loop(_a.get_running_loop())
    await init_db()
    run = await orchestrator.start_run(project_id=args.project, goal=args.goal)
    result = await orchestrator.advance(run["id"])
    from crew.core.db import session_scope
    from crew.core.models import Run

    async with session_scope() as s:
        row = await s.get(Run, run["id"])
        print(json.dumps({"result": result, "report": row.report if row else {}}, indent=2, default=str))
    return 0


async def _status() -> int:
    from crew.core.db import init_db
    from crew.execution.models import router

    await init_db()
    from crew.core.settings import settings

    return _print({"version": __version__, "contract": CONTRACT_VERSION, "env": settings.env,
                   "data_dir": str(settings.data_path), "auth_mode": settings.auth_mode,
                   "offline_llm": settings.offline_llm, "models": router.available(),
                   "tool_sandbox": settings.tool_sandbox})


async def _doctor() -> int:
    import asyncio

    from crew.control.onboarding import load_vault_provider_keys, state
    from crew.core.db import init_db, ping
    from crew.core.settings import settings
    from crew.execution.tools import _sandbox_available

    await init_db()
    await load_vault_provider_keys()
    provider_state = state()
    checks = {
        "database": await ping(),
        "sandbox": await asyncio.to_thread(_sandbox_available),
        "mode": "demo" if settings.offline_llm else "live",
        "provider_configured": any(p["id"] == provider_state["provider"] and p["configured"]
                                   for p in provider_state["providers"]),
        "data_directory": str(settings.data_path),
        "workspace_root": str(settings.default_workspace_root),
        "single_process_required": True,
    }
    _print(checks)
    return 0 if checks["database"] and (settings.offline_llm or (checks["sandbox"] and checks["provider_configured"])) else 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
