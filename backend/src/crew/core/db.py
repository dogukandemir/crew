"""Async engine / session factory / schema bootstrap (docs/01 §4, docs/10 §4)."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from crew.core.settings import settings


class Base(DeclarativeBase):
    pass


_engine = None
_factory: async_sessionmaker[AsyncSession] | None = None


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
async def session_scope() -> AsyncIterator[AsyncSession]:
    """Transactional scope. Commits on success, rolls back on error."""
    factory = session_factory()
    async with factory() as s:
        try:
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
    """Create the schema. In prod this is Alembic's job (docs/10 §4)."""
    from crew.core import models  # noqa: F401  (register mappers)

    do_create = settings.is_dev if create_all is None else create_all
    if not do_create:
        return
    async with engine().begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def drop_db() -> None:
    from crew.core import models  # noqa: F401

    async with engine().begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


async def ping() -> bool:
    try:
        async with engine().connect() as conn:
            await conn.execute(text("SELECT 1"))
        return True
    except Exception:
        return False
