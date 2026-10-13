"""Async engine / session factory / schema bootstrap (docs/01 §4, docs/10 §4)."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from contextvars import ContextVar
from functools import wraps

from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from crew.core.settings import settings


class Base(DeclarativeBase):
    pass


_engine = None
_factory: async_sessionmaker[AsyncSession] | None = None
_transaction: ContextVar[AsyncSession | None] = ContextVar("crew_transaction", default=None)


def in_transaction() -> bool:
    return _transaction.get() is not None


async def after_commit(callback) -> None:
    session = _transaction.get()
    if session is not None:
        session.info.setdefault("after_commit", []).append(callback)
    else:
        await callback()


@asynccontextmanager
async def atomic_scope():
    """Compose state changes and events in one durable SQLite transaction."""
    if _transaction.get() is not None:
        yield _transaction.get()
        return
    async with session_factory()() as session:
        await session.execute(text("BEGIN IMMEDIATE"))
        token = _transaction.set(session)
        try:
            yield session
            await session.commit()
        except BaseException:
            await session.rollback()
            raise
        finally:
            _transaction.reset(token)
        # State and event rows are durable first. A disconnected UI can replay them
        # even if this process exits before publishing these notifications.
        for callback in session.info.pop("after_commit", []):
            await callback()


def transactional(function):
    @wraps(function)
    async def wrapped(*args, **kwargs):
        async with atomic_scope():
            return await function(*args, **kwargs)
    return wrapped


def engine():
    global _engine
    if _engine is None:
        settings.ensure_dirs()
        _engine = create_async_engine(
            settings.db_url,
            echo=False,
            future=True,
            pool_pre_ping=True,
            connect_args={"timeout": 30} if settings.db_url.startswith("sqlite") else {},
        )
        if settings.db_url.startswith("sqlite"):
            @event.listens_for(_engine.sync_engine, "connect")
            def _sqlite_pragmas(dbapi_conn, _rec):  # pragma: no cover - driver hook
                cur = dbapi_conn.cursor()
                cur.execute("PRAGMA journal_mode=WAL")
                cur.execute("PRAGMA foreign_keys=ON")
                cur.execute("PRAGMA synchronous=NORMAL")
                cur.close()
    return _engine


def session_factory() -> async_sessionmaker[AsyncSession]:
    global _factory
    if _factory is None:
        _factory = async_sessionmaker(engine(), expire_on_commit=False, autoflush=False)
    return _factory


@asynccontextmanager
async def session_scope(*, write_lock: bool = False) -> AsyncIterator[AsyncSession]:
    """Transactional scope. Commits on success, rolls back on error."""
    existing = _transaction.get()
    if existing is not None:
        yield existing
        await existing.flush()
        return
    factory = session_factory()
    async with factory() as s:
        try:
            if write_lock:
                if not settings.db_url.startswith("sqlite"):
                    raise RuntimeError("this release supports SQLite for serialized governance writes")
                await s.execute(text("BEGIN IMMEDIATE"))
            yield s
            await s.commit()
        except Exception:
            await s.rollback()
            raise


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency."""
    async with session_scope() as s:
        yield s


async def init_db(create_all: bool | None = None) -> None:
    """Apply versioned migrations in development and production alike."""
    from crew.core import models  # noqa: F401  (register mappers)

    if create_all is False:
        return
    from crew.core.migrations import backup_before_upgrade, migrate

    if settings.db_url.startswith("sqlite"):
        await asyncio.to_thread(backup_before_upgrade, engine().url.database)
    async with engine().begin() as conn:
        await conn.run_sync(lambda sync: migrate(sync, Base.metadata, _add_missing_columns))


def _add_missing_columns(sync_conn) -> None:
    """SQLite dev DBs predate columns the models grew (ADR 0004: dev schema is disposable —
    but a running dev database should not have to be). ADD COLUMN is the one ALTER SQLite
    does cheaply, and the columns below are exactly the nullable-defaulted safe kind.
    """
    from sqlalchemy import inspect

    wanted = {
        "projects": {"kind": "VARCHAR(16) DEFAULT 'project'",
                     "company_id": "VARCHAR(32)"},
        "tasks": {"helpers": "JSON DEFAULT '[]'"},
        "agents": {"break_until": "DATETIME", "company_knowledge": "FLOAT DEFAULT 0",
                   "soul": "JSON DEFAULT '{}'"},
    }
    insp = inspect(sync_conn)
    tables = set(insp.get_table_names())
    for table, columns in wanted.items():
        if table not in tables:
            continue
        have = {c["name"] for c in insp.get_columns(table)}
        for name, ddl in columns.items():
            if name not in have:
                sync_conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")


async def drop_db() -> None:
    from crew.core import models  # noqa: F401

    async with engine().begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.execute(text("DROP TABLE IF EXISTS crew_schema_version"))


async def ping() -> bool:
    try:
        async with engine().connect() as conn:
            await conn.execute(text("SELECT 1"))
        return True
    except Exception:
        return False
