"""Bounded HTTP fetching with validated, pinned public destination addresses."""

import http.client
import ipaddress
import socket
import ssl
from urllib.parse import urljoin, urlsplit

from crew.core.security import policy

MAX_RESPONSE_BYTES = 64_000


def public_addresses(host: str, port: int) -> list[str]:
    addresses = list(dict.fromkeys(info[4][0] for info in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)))
    if not addresses or any(not ipaddress.ip_address(ip).is_global for ip in addresses):
        raise PermissionError("destination resolves to a private or reserved address")
    return addresses


class PinnedConnection(http.client.HTTPConnection):
    def __init__(self, host: str, port: int, address: str, secure: bool):
        super().__init__(host, port, timeout=20)
        self.address, self.secure = address, secure

    def connect(self):
        # Do not resolve the hostname a second time between validation and connection.
        self.sock = socket.create_connection((self.address, self.port), self.timeout)
        if self.secure:
            self.sock = ssl.create_default_context().wrap_socket(self.sock, server_hostname=self.host)


def fetch_public(url: str, project=None) -> tuple[int, str, str]:
    for _hop in range(6):
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or parts.username or parts.password or not parts.hostname:
            raise PermissionError("only credential-free HTTP(S) URLs are allowed")
        host = parts.hostname.encode("idna").decode("ascii")
        port = parts.port or (443 if parts.scheme == "https" else 80)
        if port not in (80, 443):
            raise PermissionError("destination port is not allowed")
        decision = policy.check_egress(host, project)
        if not decision.allowed:
            raise PermissionError(decision.reason)
        address = public_addresses(host, port)[0]
        connection = PinnedConnection(host, port, address, parts.scheme == "https")
        try:
            target = parts.path or "/"
            if parts.query:
                target += "?" + parts.query
            connection.request("GET", target, headers={"User-Agent": "crew-agent/0.1", "Accept-Encoding": "identity"})
            response = connection.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                location = response.getheader("Location")
                if not location:
                    raise ValueError("redirect has no location")
                url = urljoin(url, location)
                continue
            body = response.read(MAX_RESPONSE_BYTES + 1)
            if len(body) > MAX_RESPONSE_BYTES:
                raise ValueError("response exceeds 64000-byte limit")
            return response.status, body.decode("utf-8", errors="replace"), url
        finally:
            connection.close()
    raise PermissionError("too many redirects")
