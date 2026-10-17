"""The published example has to keep verifying.

`examples/temperature-converter` is the repo's public proof that a live run produces real,
inspectable work: a manifest of sha256 hashes, the source it hashes, and the captured execution
report. On 16 October the README was edited (the em-dash sweep) and the manifest was not, so the
"verified example" failed its own recorded hash for a day. This test is the guard: a future edit
to any published file fails here instead of on a stranger's clone.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path

EXAMPLE = Path(__file__).resolve().parents[3] / "examples" / "temperature-converter"
MANIFEST = EXAMPLE / "artifact-manifest.json"


def _load_converter():
    spec = importlib.util.spec_from_file_location("published_converter", EXAMPLE / "converter.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_every_published_file_matches_its_recorded_hash():
    recorded = json.loads(MANIFEST.read_text(encoding="utf-8"))
    assert len(recorded) == 4, "the manifest describes four files"
    for row in recorded:
        data = (EXAMPLE / row["name"]).read_bytes()
        assert len(data) == row["bytes"], f"{row['name']}: recorded {row['bytes']} bytes, found {len(data)}"
        assert hashlib.sha256(data).hexdigest() == row["sha256"], f"{row['name']}: sha256 drifted from the manifest"


def test_the_example_converter_behaves_as_the_captured_report_claims():
    converter = _load_converter()
    assert converter.celsius_to_fahrenheit(0) == 32
    assert converter.celsius_to_fahrenheit(100) == 212
    assert converter.fahrenheit_to_celsius(32) == 0
    assert round(converter.fahrenheit_to_celsius(212), 6) == 100
    for bad in ("10", None, [1]):
        try:
            converter.celsius_to_fahrenheit(bad)
        except TypeError:
            continue
        raise AssertionError(f"{bad!r} must raise TypeError")
