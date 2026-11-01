"""A smarter search: a provider chain, a read depth, and three honest answers.

The finding: one hard-coded DuckDuckGo scrape was the only search, so an anti-bot
challenge or a changed page shape was the end of the question. Now DuckDuckGo html,
DuckDuckGo lite and (for encyclopedic queries) the Wikipedia API are tried in turn, a
provider failure falls through, and `depth='read'` hands the agent content, not links.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from crew.core.db import session_scope
from crew.core.models import Agent
from crew.domain.enums import Capability
from crew.execution import tools as tools_mod
from crew.execution.tools import invoker

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "search"


def _fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


# ── parsers, against saved shapes (no network) ──────────────────────────────────────
def test_the_live_lite_page_yields_title_url_and_snippet():
    hits = tools_mod.parse_search_results(_fixture("ddg_lite_results.html"))

    assert len(hits) == 5
    first = hits[0]
    assert first["url"].startswith("https://www.digitaltrends.com/")
    assert first["title"].startswith("The best noise-canceling headphones of 2025")
    assert "noisy world" in first["snippet"], "the snippet is real text, not markup"
    assert all(set(h) == {"title", "url", "snippet"} for h in hits), "one normalised shape"
    assert all(h["snippet"] for h in hits), "every saved row carries its snippet"


def test_the_html_endpoint_shape_parses_and_unwraps_the_redirect():
    hits = tools_mod.parse_search_results(_fixture("ddg_html_results.html"))

    assert len(hits) == 2
    assert hits[0]["url"] == "https://docs.python.org/3/library/json.html"
    assert "JSON encoder and decoder" in hits[0]["title"]
    assert hits[0]["snippet"].startswith("This module can be used to encode")
    assert hits[1]["url"] == ("https://developer.mozilla.org/en-US/docs/Web/JavaScript/"
                              "Reference/Global_Objects/JSON")


def test_the_wikipedia_api_shape_parses_into_the_same_normalised_hits():
    hits = tools_mod.parse_wikipedia_results(_fixture("wikipedia_search.json"))

    assert [h["title"] for h in hits] == ["Vector database", "Approximate nearest neighbor search"]
    assert hits[0]["url"] == "https://en.wikipedia.org/wiki/Vector_database"
    assert "<span" not in hits[0]["snippet"] and "vector database is a database" in hits[0]["snippet"]


def test_a_wikipedia_payload_that_is_not_json_is_no_hits():
    assert tools_mod.parse_wikipedia_results("<html>maintenance</html>") == []


@pytest.mark.parametrize("query", ["history of the roman empire", "vector database for backend engineers"])
def test_an_encyclopedic_lookup_joins_the_chain(query):
    assert tools_mod.looks_encyclopedic(query) is True
    assert "wikipedia" in tools_mod.providers_for(query)


@pytest.mark.parametrize("query", ["headphones", '"exact phrase"', "site:example.com atlas",
                                   "https://example.com/page", "cheap noise cancelling headphones price"])
def test_a_non_encyclopedic_query_never_reaches_wikipedia(query):
    assert tools_mod.looks_encyclopedic(query) is False
    assert "wikipedia" not in tools_mod.providers_for(query)


# ── extraction ──────────────────────────────────────────────────────────────────────
def test_extraction_strips_scripts_styles_and_tags_and_collapses_whitespace():
    page = ("<html><head><title>t</title><style>body{color:red}</style></head><body>"
            "<script>var secret = 'should not appear';</script>"
            "<h1>Heading</h1>\n\n   <p>First   paragraph &amp; more.</p>"
            "<noscript>ignore me</noscript><!-- comment --></body></html>")

    text = tools_mod.extract_readable(page)

    assert "secret" not in text and "color:red" not in text and "ignore me" not in text
    assert "Heading" in text and "First paragraph & more." in text
    assert "  " not in text and "\n" not in text, "whitespace is collapsed"


def test_extraction_is_capped_at_about_four_thousand_characters():
    text = tools_mod.extract_readable("<p>" + ("word " * 2000) + "</p>")
    assert len(text) == 4000


# ── the chain ──────────────────────────────────────────────────────────────────────
async def _agent(project_id: str) -> Agent:
    async with session_scope() as s:
        a = Agent(project_id=project_id, name="Researcher", role="worker", grade=5, state="idle",
                  tools=[Capability.NET_SEARCH.value, Capability.NET_FETCH.value],
                  autonomy="autonomous", mission="search tests")
        s.add(a)
        await s.flush()
        row = await s.get(Agent, a.id)
        s.expunge(row)
    return row


def test_a_failing_provider_falls_through_to_the_next(monkeypatch):
    def boom(query, grants=()):
        raise ConnectionError("html endpoint down")

    monkeypatch.setattr(tools_mod, "_html_search_page", boom)
    monkeypatch.setattr(tools_mod, "_search_page", lambda q, grants=(): _fixture("ddg_lite_results.html"))

    hits, provider, attempts, empty = tools_mod._search_chain("noise cancelling headphones")

    assert provider == "duckduckgo_lite" and len(hits) == 5
    assert attempts[0]["provider"] == "duckduckgo_html" and attempts[0]["outcome"] == "failed"
    assert empty is None


def test_an_encyclopedic_query_can_fall_all_the_way_to_wikipedia(monkeypatch):
    def boom(query, grants=()):
        raise ConnectionError("ddg is down")

    monkeypatch.setattr(tools_mod, "_html_search_page", boom)
    monkeypatch.setattr(tools_mod, "_search_page", boom)
    monkeypatch.setattr(tools_mod, "_wikipedia_search_page",
                        lambda q, grants=(): _fixture("wikipedia_search.json"))

    hits, provider, attempts, _ = tools_mod._search_chain("vector database history")

    assert provider == "wikipedia" and hits[0]["title"] == "Vector database"
    assert [a["outcome"] for a in attempts] == ["failed", "failed", "results"]


@pytest.mark.asyncio
async def test_the_three_answers_are_three_different_strings(
        project, tool_context, bound_loop, tmp_path, monkeypatch):
    """A working provider with no results, every provider failing, and a blocked host."""
    from types import SimpleNamespace

    agent = await _agent(project["id"])
    ctx = await tool_context(project_id=project["id"], agent=agent, task_id="t-strings",
                             workspace=tmp_path)

    monkeypatch.setattr(tools_mod, "_html_search_page", lambda q, grants=(): _fixture("ddg_lite_no_results.html"))
    monkeypatch.setattr(tools_mod, "_search_page", lambda q, grants=(): _fixture("ddg_lite_no_results.html"))
    monkeypatch.setattr(tools_mod, "_wikipedia_search_page",
                        lambda q, grants=(): (_ for _ in ()).throw(AssertionError("no wikipedia for a one-word query")))
    empty = await asyncio.to_thread(invoker.invoke, ctx, "web_search", {"query": "zzzzqqqq"})
    assert empty["ok"] is True and empty["data"] == []
    assert "genuine empty answer" in empty["note"]

    def boom(query, grants=()):
        raise ConnectionError("dns down")

    monkeypatch.setattr(tools_mod, "_html_search_page", boom)
    monkeypatch.setattr(tools_mod, "_search_page", boom)
    failed = await asyncio.to_thread(invoker.invoke, ctx, "web_search", {"query": "zzzzqqqq"})
    assert failed["ok"] is False and failed["error"].startswith("search_unavailable:")

    monkeypatch.setattr(tools_mod.policy, "check_egress",
                        lambda host, proj: SimpleNamespace(allowed=False, reason="blocked for test"))
    blocked = await asyncio.to_thread(invoker.invoke, ctx, "web_search", {"query": "zzzzqqqq"})
    assert blocked["ok"] is False and blocked["error"] == "approval_required"

    assert empty["note"] != failed["error"] != blocked["error"]
    assert "genuine empty answer" not in failed["error"]


# ── read depth ─────────────────────────────────────────────────────────────────────
_READING_PAGE = ("<html><head><style>p{}</style></head><body><script>evil()</script>"
                 "<article><h1>Vector indexes</h1><p>Approximate nearest neighbour search "
                 "trades recall for speed.</p></article></body></html>")


@pytest.mark.asyncio
async def test_read_depth_returns_content_through_the_same_egress_gate(
        project, tool_context, bound_loop, tmp_path, monkeypatch):
    agent = await _agent(project["id"])
    ctx = await tool_context(project_id=project["id"], agent=agent, task_id="t-read",
                             workspace=tmp_path)
    serp = "".join(
        f'<a class="result__a" href="{url}">Source {i}</a>'
        f'<a class="result__snippet" href="{url}">snippet {i}</a>'
        for i, url in enumerate(["https://github.com/a", "https://raw.githubusercontent.com/b",
                                 "https://pypi.org/c", "https://github.com/d"]))
    monkeypatch.setattr(tools_mod, "_html_search_page", lambda q, grants=(): serp)
    fetched = []

    def fake_fetch(url, project=None, granted_hosts=()):
        fetched.append(url)
        return 200, _READING_PAGE, url

    monkeypatch.setattr(tools_mod, "_fetch_url", fake_fetch)

    quick = await asyncio.to_thread(invoker.invoke, ctx, "web_search", {"query": "vector index"})
    deep = await asyncio.to_thread(invoker.invoke, ctx, "web_search",
                                   {"query": "vector index", "depth": "read"})

    assert quick["meta"]["depth"] == "quick" and "text" not in quick["data"][0]
    assert deep["meta"]["depth"] == "read" and deep["meta"]["read"] == 3
    assert len(deep["data"]) == 3, "the top three are read, the fourth stays a link"
    assert all("Approximate nearest neighbour" in row["text"] for row in deep["data"])
    assert all("evil()" not in row["text"] for row in deep["data"]), "scripts never reach the agent"
    assert len(set(fetched)) == 3

    bad = await asyncio.to_thread(invoker.invoke, ctx, "web_search",
                                  {"query": "vector index", "depth": "deep"})
    assert bad["ok"] is False and "depth must be" in bad["error"]


@pytest.mark.asyncio
async def test_read_depth_leaves_a_blocked_result_as_a_link_with_a_reason(
        project, tool_context, bound_loop, tmp_path, monkeypatch):
    agent = await _agent(project["id"])
    ctx = await tool_context(project_id=project["id"], agent=agent, task_id="t-read2",
                             workspace=tmp_path)
    serp = '<a class="result__a" href="https://blocked.example.org/a">Blocked source</a>'
    monkeypatch.setattr(tools_mod, "_html_search_page", lambda q, grants=(): serp)
    monkeypatch.setattr(tools_mod, "_search_page", lambda q, grants=(): serp)
    monkeypatch.setattr(tools_mod, "_fetch_url",
                        lambda url, project=None, granted_hosts=(): (200, _READING_PAGE, url))

    deep = await asyncio.to_thread(invoker.invoke, ctx, "web_search",
                                   {"query": "blocked source", "depth": "read"})

    assert deep["ok"] is True
    row = deep["data"][0]
    assert row["text"] == "" and row["read_error"] == "approval_required", row
    assert row["url"] == "https://blocked.example.org/a", "the link still reaches the agent"


def test_the_normalised_shape_has_no_missing_keys_on_an_unknown_page():
    """A page we cannot read yields no rows, never a row without a snippet."""
    assert tools_mod.parse_search_results("<html><body>nothing here</body></html>") == []
    assert json.loads(json.dumps(tools_mod.parse_search_results(_fixture("ddg_lite_results.html"))))
