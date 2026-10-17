"""The public tree names nothing the public cannot see.

Two rounds of audits found tracked files naming a private sibling product and the author's
machine paths. A rewrite of history cannot fix a leak that is still in the tip, and re-reporting
the same strings every audit is the cost of not having a guard. This is the guard.

The scan walks the repository outside the directories a clone does not contain (virtualenvs,
node_modules, caches, the runtime data dir) and ignores binary files. The test file itself is
skipped, because it has to spell out the names it forbids.
"""

from __future__ import annotations

from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
SKIP_DIRS = {".git", ".venv", "node_modules", "__pycache__", "data", "dist", ".ruff_cache",
             ".gitleaks_cache", ".pytest_cache", "coverage", "htmlcov", ".mypy_cache"}
SKIP_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2", ".ttf",
                 ".pdf", ".zip", ".sqlite", ".db", ".pyc", ".so", ".dll", ".exe"}

# Other projects of the author, and this machine. Neither belongs in a published tree.
FORBIDDEN = ("kaffeklip", "channelfactory", "c:\\users\\doguk", "c:/users/doguk", "/c/projects/github")


def _scan() -> list[str]:
    hits: list[str] = []
    me = Path(__file__).resolve()
    for path in REPO.rglob("*"):
        if not path.is_file() or path.resolve() == me:
            continue
        if any(part in SKIP_DIRS for part in path.parts) or path.suffix.lower() in SKIP_SUFFIXES:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        lowered = text.lower()
        for needle in FORBIDDEN:
            if needle in lowered:
                hits.append(f"{path.relative_to(REPO)}: {needle}")
    return hits


def test_the_tree_names_no_private_sibling_project_and_no_machine_path():
    hits = _scan()
    assert hits == [], "public tree contamination: " + "; ".join(hits[:12])
