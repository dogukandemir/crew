"""Run the suite as a host with NO desktop directory picker (the ubuntu CI runner).

The founding wizard's Browse button (ADR 0017) is answered by the machine, so
`crew.api.routes._picker_available()` is host state: True where powershell /
osascript / zenity exists, False on a bare runner. A test that asserts host
availability instead of pinning it passes on Windows and fails on ubuntu — which is
exactly what the first CI observation found. This plugin makes that condition reachable
on any host, so the Linux path cannot regress unnoticed.

Usage (from `backend/`):

    PYTHONPATH=tests/plugins uv run pytest -p no_picker -q
    PYTHONPATH=tests/plugins uv run pytest -p no_picker tests/api/test_api.py -k pick_directory -q

Tests that pin availability themselves (monkeypatch `_picker_available`) override this.
"""
import pytest


@pytest.fixture(autouse=True)
def _host_without_a_picker(monkeypatch):
    from crew.api import routes

    monkeypatch.setattr(routes, "_picker_available", lambda: False)
