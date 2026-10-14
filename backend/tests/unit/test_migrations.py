"""The upgrade path: a database from an older release must migrate on boot.

The suite builds fresh schemas (drop_db + create_all), so the path a real
installation takes — an EXISTING data dir whose schema predates an additive column —
is easy to leave broken. It was: starting the app against a pre-review data dir raised
`database schema mismatch in audit_log: missing ['project_id']` because no revision
carried the ADD COLUMN. These tests build the old shape explicitly on a temp DB.
"""

from __future__ import annotations

import pytest
from sqlalchemy import create_engine, inspect


def test_migrate_upgrades_a_pre_review_database(tmp_path):
    from crew.core import models  # noqa: F401  (register mappers)
    from crew.core.db import Base, _add_missing_columns
    from crew.core.migrations import CURRENT_VERSION, migrate

    engine = create_engine(f"sqlite:///{tmp_path / 'old.sqlite'}")
    with engine.begin() as conn:
        Base.metadata.create_all(conn)
        # simulate the previous release: the column (and its index) absent, stamped at 2
        conn.exec_driver_sql("DROP INDEX IF EXISTS ix_audit_log_project_id")
        conn.exec_driver_sql("ALTER TABLE audit_log DROP COLUMN project_id")
        conn.exec_driver_sql("CREATE TABLE IF NOT EXISTS crew_schema_version "
                             "(version INTEGER PRIMARY KEY)")
        conn.exec_driver_sql("INSERT INTO crew_schema_version(version) VALUES (2)")

    with engine.begin() as conn:
        migrate(conn, Base.metadata, _add_missing_columns)  # must NOT raise
        cols = {c["name"] for c in inspect(conn).get_columns("audit_log")}
        version = conn.exec_driver_sql("SELECT MAX(version) FROM crew_schema_version").scalar_one()

    assert "project_id" in cols, "revision 3 re-adds the additive column"
    assert version == CURRENT_VERSION, "the upgrade is stamped"
    engine.dispose()


def test_migrate_still_refuses_a_partially_missing_schema(tmp_path):
    """Additions are healed; a genuinely partial schema still errors (never silent)."""
    from crew.core import models  # noqa: F401
    from crew.core.db import Base, _add_missing_columns
    from crew.core.migrations import migrate

    engine = create_engine(f"sqlite:///{tmp_path / 'partial.sqlite'}")
    with engine.begin() as conn:
        Base.metadata.create_all(conn)
        conn.exec_driver_sql("ALTER TABLE audit_log DROP COLUMN actor_id")  # not in the ADD list
        conn.exec_driver_sql("CREATE TABLE IF NOT EXISTS crew_schema_version "
                             "(version INTEGER PRIMARY KEY)")
        conn.exec_driver_sql("INSERT INTO crew_schema_version(version) VALUES (3)")
    try:
        with engine.begin() as conn, pytest.raises(RuntimeError):
            migrate(conn, Base.metadata, _add_missing_columns)
    finally:
        engine.dispose()
