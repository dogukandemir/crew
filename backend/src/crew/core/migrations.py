"""Versioned, forward-only migrations for the supported SQLite distribution.

Revision 1 adopts the pre-release schema and its known additive upgrades. Future
schema changes must add a revision; never edit an already released revision.

Revision 3 (2026-10 review round) is purely additive: the audit scope column
(`audit_log.project_id`) for databases that predate it. Caught live when the app was
started against a real pre-review data dir: the strict mismatch check fired because no
revision carried the ADD COLUMN.
"""

import sqlite3
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import inspect

CURRENT_VERSION = 3


def backup_before_upgrade(database: str) -> Path | None:
    """Use SQLite's backup API so committed WAL contents are included."""
    path = Path(database)
    if not path.is_file() or not path.stat().st_size:
        return None
    with sqlite3.connect(path) as source:
        exists = source.execute("SELECT 1 FROM sqlite_master WHERE name='crew_schema_version'").fetchone()
        version = source.execute("SELECT COALESCE(MAX(version),0) FROM crew_schema_version").fetchone()[0] if exists else 0
        if version >= CURRENT_VERSION:
            return None
        target = path.parent / "backups" / f"before-schema-{CURRENT_VERSION}-{datetime.now(UTC):%Y%m%dT%H%M%S%f}.sqlite"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.touch(mode=0o600, exist_ok=False)
        with sqlite3.connect(target) as backup:
            source.backup(backup)
        return target


def migrate(connection, metadata, legacy_upgrade) -> None:
    connection.exec_driver_sql("CREATE TABLE IF NOT EXISTS crew_schema_version (version INTEGER PRIMARY KEY)")
    version = connection.exec_driver_sql("SELECT COALESCE(MAX(version), 0) FROM crew_schema_version").scalar_one()
    if version > CURRENT_VERSION:
        raise RuntimeError("database was created by a newer Crew release; restore its matching application version")
    if version < 1:
        metadata.create_all(connection)
        legacy_upgrade(connection)
        connection.exec_driver_sql("INSERT INTO crew_schema_version(version) VALUES (1)")
    if version < 2:
        metadata.tables["command_receipts"].create(connection, checkfirst=True)
        connection.exec_driver_sql("INSERT INTO crew_schema_version(version) VALUES (2)")
    if version < 3:
        # Additive only (the callback inspects + ALTERs, so re-running it is safe).
        legacy_upgrade(connection)
        if "audit_log" in inspect(connection).get_table_names():
            connection.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_audit_log_project_id ON audit_log (project_id)")
        connection.exec_driver_sql("INSERT INTO crew_schema_version(version) VALUES (3)")
    # A partial schema is an error, not a fresh database that can silently hide data loss.
    inspector = inspect(connection)
    for table in metadata.sorted_tables:
        actual = {c["name"] for c in inspector.get_columns(table.name)}
        missing = {c.name for c in table.columns} - actual
        if missing:
            raise RuntimeError(f"database schema mismatch in {table.name}: missing {sorted(missing)}")
