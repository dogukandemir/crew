"""Atomic, replayable command boundaries for creation endpoints."""
import hashlib
import inspect
import json
from functools import wraps

from fastapi import HTTPException

from crew.core.db import after_commit, atomic_scope
from crew.core.models import CommandReceipt


def replayable(function):
    @wraps(function)
    async def wrapped(*args, **kwargs):
        body, user = kwargs["body"], kwargs["user"]
        key = getattr(body, "idempotency_key", None)
        scope = json.dumps({k: v for k, v in kwargs.items() if k not in ("body", "user")}, sort_keys=True)
        receipt_id = hashlib.sha256(f"{user['id']}:{function.__name__}:{scope}:{key}".encode()).hexdigest()
        digest = hashlib.sha256(json.dumps(body.model_dump(), sort_keys=True).encode()).hexdigest()
        async with atomic_scope() as session:
            receipt = await session.get(CommandReceipt, receipt_id) if key else None
            if receipt:
                if receipt.request_hash != digest:
                    raise HTTPException(409, "idempotency key was used with different input")
                return receipt.response
            result = await function(*args, **kwargs)
            if key:
                session.add(CommandReceipt(id=receipt_id, request_hash=digest, response=result))
            return result
    wrapped.__signature__ = inspect.signature(function, eval_str=True)
    return wrapped


async def drive_after_commit(project_id, run_id):
    import asyncio

    from crew.api.routes import _drive

    async def schedule():
        asyncio.create_task(_drive(project_id, run_id))
    await after_commit(schedule)
