"""F2: the search parser reads the real DuckDuckGo page shapes, offline.

The live finding was a price sheet saying a web search "returned no usable results".
The tool was GETting an endpoint that now answers an anti-bot challenge, and its
parser only knew one anchor shape. These fixtures are saved snippets of real
responses: no network in tests.
"""

from __future__ import annotations

from pathlib import Path

from crew.execution import tools

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "search"


def _page(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def test_the_live_lite_results_page_parses_into_hits():
    page = _page("ddg_lite_results.html")

    hits = tools.parse_search_hits(page)

    assert len(hits) == 5, "the lite page carries more, the tool asks for five"
    first = hits[0]
    assert first["url"] == ("https://www.digitaltrends.com/home-theater/"
                            "best-noise-canceling-headphones/")
    assert first["title"].startswith("The best noise-canceling headphones of 2025")
    assert all(h["url"].startswith("http") for h in hits)
    assert all(h["title"] and "<" not in h["title"] for h in hits), "titles are text, not markup"
    assert tools.classify_search_page(page) == "results"


def test_a_genuine_empty_answer_is_distinguishable_from_a_broken_fetch():
    page = _page("ddg_lite_no_results.html")

    assert tools.parse_search_hits(page) == []
    assert tools.classify_search_page(page) == "empty", \
        "the engine says it ran the query and found nothing"


def test_the_anti_bot_challenge_is_reported_as_blocked():
    page = _page("ddg_html_challenge.html")

    assert tools.parse_search_hits(page) == []
    assert tools.classify_search_page(page) == "blocked", \
        "a challenge page is a broken fetch, never a zero-result answer"


def test_a_page_that_is_neither_results_nor_a_challenge_is_unparsed():
    assert tools.classify_search_page("<html><body>maintenance</body></html>") == "unparsed"


def test_the_older_html_result_shape_and_redirect_wrapper_still_parse():
    page = ('<a rel="nofollow" class="result__a" '
            'href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fshop.example%2Fprice">'
            'Rival <b>prices</b> compared</a>')

    assert tools.parse_search_hits(page) == [
        {"url": "https://shop.example/price", "title": "Rival prices compared"}]


def test_the_search_request_is_a_form_post_to_the_allowed_host():
    """The cause of the empty results: a GET got a 202 challenge, the POST does not."""
    from crew.core.security import policy

    assert tools.SEARCH_URL.startswith(f"https://{tools.SEARCH_HOST}/")
    assert policy.check_egress(tools.SEARCH_HOST, None).allowed, \
        "the search host must stay inside the honest egress allowlist"
