"""Exercise redirects, address pinning and bounded reads without network traffic."""
from types import SimpleNamespace

import pytest

from crew.execution import http


def test_mixed_public_private_dns_is_rejected(monkeypatch):
    monkeypatch.setattr(http.socket, "getaddrinfo", lambda *a, **kw: [
        (2, 1, 6, "", ("8.8.8.8", 443)), (2, 1, 6, "", ("127.0.0.1", 443))])
    with pytest.raises(PermissionError, match="private"):
        http.public_addresses("example.org", 443)


def test_redirect_cannot_bypass_destination_policy(monkeypatch):
    monkeypatch.setattr(http.policy, "check_egress", lambda *a: SimpleNamespace(allowed=True))
    seen = []
    def addresses(host, port):
        seen.append(host)
        if host == "127.0.0.1":
            raise PermissionError("private address")
        return ["8.8.8.8"]
    monkeypatch.setattr(http, "public_addresses", addresses)
    class Redirect:
        status = 302
        def getheader(self, name):
            return "http://127.0.0.1/admin"
    class Connection:
        def __init__(self, *args):
            assert args[2] == "8.8.8.8"
        def request(self, *args, **kwargs):
            pass
        def getresponse(self):
            return Redirect()
        def close(self):
            pass
    monkeypatch.setattr(http, "PinnedConnection", Connection)
    with pytest.raises(PermissionError, match="private"):
        http.fetch_public("https://example.org")
    assert seen == ["example.org", "127.0.0.1"]


def test_response_limit_is_enforced_at_read(monkeypatch):
    monkeypatch.setattr(http.policy, "check_egress", lambda *a: SimpleNamespace(allowed=True))
    monkeypatch.setattr(http, "public_addresses", lambda *a: ["8.8.8.8"])
    class Response:
        status = 200
        def read(self, limit):
            assert limit == http.MAX_RESPONSE_BYTES + 1
            return b"x" * limit
    class Connection:
        def __init__(self, *args):
            pass
        def request(self, *args, **kwargs):
            pass
        def getresponse(self):
            return Response()
        def close(self):
            pass
    monkeypatch.setattr(http, "PinnedConnection", Connection)
    with pytest.raises(ValueError, match="limit"):
        http.fetch_public("https://example.org")


def test_connection_uses_validated_numeric_address(monkeypatch):
    seen = []
    monkeypatch.setattr(http.socket, "create_connection", lambda *a: seen.append(a))
    connection = http.PinnedConnection("example.org", 80, "8.8.8.8", False)
    connection.connect()
    assert seen == [(("8.8.8.8", 80), 20)]
