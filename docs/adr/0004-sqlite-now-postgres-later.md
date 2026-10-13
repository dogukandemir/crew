# ADR 0004 — SQLite now, Postgres later

- **Status:** Accepted
- **Date:** 2026-10-06

## Context
This must run on the user's Windows workstation with zero infrastructure, yet grow to a
multi-worker deployment (multiple schedulers, Redis bus) without a rewrite.

## Decision
- Dev/default: SQLite (WAL mode) + `sqlite-vec` for vectors + FTS5 for keyword search.
- Prod/horizontal: Postgres + pgvector + Redis Streams.
- Enforced by interfaces: repositories take a project scope and use SQLAlchemy 2.x constructs
  that are portable; JSON columns and vector access live behind adapters
  (`core/repo/vectors.py`); schema changes go through the forward-only migrator
  (`core/migrations.py`) with no SQLite-only DDL.

## Consequences
- Zero-setup local development; the whole product runs with one command.
- Some features (concurrent writers, vector index quality) are limited in dev; load tests must
  run against Postgres.
- Switching storage is configuration plus a migration, not a code change.
