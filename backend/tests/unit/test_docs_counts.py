"""The specification counts the published surfaces claim must equal the tree.

A stated number is a promise a reader cannot check by reading: 18 documents and 19
ADRs is either what `docs/` holds or it is a small lie that survives every review
because nobody counts a directory mid-read. These assertions read the claim and the
directory side by side, so a drift fails a test instead of shipping.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
DOCS = REPO_ROOT / "docs"
ADR_DIR = DOCS / "adr"

# Every published surface that states the specification's size.
CLAIM_FILES = (
    REPO_ROOT / "README.md",
    REPO_ROOT / "llms.txt",
    REPO_ROOT / "site" / "llms.txt",
    REPO_ROOT / "site" / "index.html",
)

# "18 documents", "18 numbered documents", "18 specification documents".
DOC_CLAIM_RE = re.compile(r"(\d+)\s+(?:numbered\s+)?(?:specification\s+)?documents")
# "19 ADRs".
ADR_CLAIM_RE = re.compile(r"(\d+)\s+ADRs")


def _claimed(path: Path, pattern: re.Pattern[str]) -> int:
    text = path.read_text(encoding="utf-8")
    found = pattern.search(text)
    assert found is not None, f"{path.relative_to(REPO_ROOT)} states no count matching /{pattern.pattern}/"
    return int(found.group(1))


def test_specification_counts_match_the_repository() -> None:
    numbered = sorted(p.name for p in DOCS.glob("[0-9][0-9]-*.md"))
    adrs = sorted(p.name for p in ADR_DIR.glob("[0-9][0-9][0-9][0-9]-*.md"))
    assert numbered, "docs/ holds no numbered specification document"
    assert adrs, "docs/adr/ holds no ADR"

    for path in CLAIM_FILES:
        where = path.relative_to(REPO_ROOT).as_posix()
        assert _claimed(path, ADR_CLAIM_RE) == len(adrs), f"{where} claims a different ADR count than docs/adr holds"
        assert _claimed(path, DOC_CLAIM_RE) == len(numbered), f"{where} claims a different document count than docs/ holds"
