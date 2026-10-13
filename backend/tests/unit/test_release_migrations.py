import sqlite3

import pytest
from sqlalchemy import create_engine
from sqlalchemy.exc import NoSuchTableError

from crew.core.db import Base, _add_missing_columns
from crew.core.migrations import CURRENT_VERSION, backup_before_upgrade, migrate


def test_upgrade_preserves_data_and_backup_is_restorable(tmp_path):
    path = tmp_path / "old.sqlite"
    engine = create_engine(f"sqlite:///{path}")
    with engine.begin() as connection:
        Base.metadata.create_all(connection)
        connection.exec_driver_sql("CREATE TABLE migration_fixture (value TEXT)")
        connection.exec_driver_sql("INSERT INTO migration_fixture VALUES ('keep me')")
    backup = backup_before_upgrade(str(path))
    assert backup and backup.is_file()
    with engine.begin() as connection:
        migrate(connection, Base.metadata, _add_missing_columns)
        migrate(connection, Base.metadata, _add_missing_columns)
        assert connection.exec_driver_sql("SELECT value FROM migration_fixture").scalar_one() == "keep me"
        assert connection.exec_driver_sql("SELECT MAX(version) FROM crew_schema_version").scalar_one() == CURRENT_VERSION
    assert backup_before_upgrade(str(path)) is None
    with sqlite3.connect(backup) as source, sqlite3.connect(tmp_path / "restored.sqlite") as restored:
        source.backup(restored)
        assert restored.execute("SELECT value FROM migration_fixture").fetchone() == ("keep me",)
    engine.dispose()


def test_newer_and_incomplete_schemas_fail_loudly(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'invalid.sqlite'}")
    with engine.begin() as connection:
        connection.exec_driver_sql("CREATE TABLE crew_schema_version (version INTEGER PRIMARY KEY)")
        connection.exec_driver_sql("INSERT INTO crew_schema_version VALUES (999)")
        with pytest.raises(RuntimeError, match="newer"):
            migrate(connection, Base.metadata, _add_missing_columns)
        connection.exec_driver_sql("UPDATE crew_schema_version SET version=2")
        with pytest.raises(NoSuchTableError):
            migrate(connection, Base.metadata, _add_missing_columns)
    engine.dispose()
