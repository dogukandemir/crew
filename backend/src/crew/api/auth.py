"""Auth: local single-user mode + HS256 bearer tokens (docs/08 §2).

Password hashing uses stdlib scrypt (no extra dependency); if argon2-cffi is installed it is
preferred. Tokens are signed with HMAC-SHA256 and carry `sub`, `role`, `exp`, `jti`.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time

from fastapi import Depends, Header, HTTPException, Request, status
from sqlalchemy import select

from crew.core.db import session_scope
from crew.core.models import SessionToken, User, uid
from crew.core.security import audit
from crew.core.settings import settings

LOCAL_USER_ID = "local-user"
LOCAL_USER = {"id": LOCAL_USER_ID, "email": "local@crew", "name": "Local Operator", "role": "admin"}


# ── password hashing ────────────────────────────────────────────────────────────────
def hash_password(password: str) -> str:
    try:
        from argon2 import PasswordHasher

        return "argon2$" + PasswordHasher().hash(password)
    except Exception:
        salt = os.urandom(16)
        dk = hashlib.scrypt(password.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
        return "scrypt$" + base64.b64encode(salt).decode() + "$" + base64.b64encode(dk).decode()


def verify_password(password: str, stored: str) -> bool:
    if stored.startswith("argon2$"):
        try:
            from argon2 import PasswordHasher

            return PasswordHasher().verify(stored[len("argon2$"):], password)
        except Exception:
            return False
    if stored.startswith("scrypt$"):
        _, salt_b64, dk_b64 = stored.split("$", 2)
        salt, expected = base64.b64decode(salt_b64), base64.b64decode(dk_b64)
        dk = hashlib.scrypt(password.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=len(expected))
        return hmac.compare_digest(dk, expected)
    return False


# ── tokens ──────────────────────────────────────────────────────────────────────────
def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def issue_token(user_id: str, role: str = "admin", ttl_min: int | None = None) -> str:
    ttl = (ttl_min or settings.access_token_ttl_min) * 60
    header = {"alg": "HS256", "typ": "JWT"}
    body = {"sub": user_id, "role": role, "iat": int(time.time()), "exp": int(time.time()) + ttl,
            "jti": uid()[:16]}
    signing = f"{_b64(json.dumps(header, separators=(',', ':')).encode())}." \
              f"{_b64(json.dumps(body, separators=(',', ':')).encode())}"
    secret = settings.jwt_secret or "dev-insecure-secret-change-me"
    sig = _b64(hmac.new(secret.encode(), signing.encode(), hashlib.sha256).digest())
    return f"{signing}.{sig}"


def decode_token(token: str) -> dict | None:
    try:
        head, body, sig = token.split(".")
    except ValueError:
        return None
    secret = settings.jwt_secret or "dev-insecure-secret-change-me"
    expected = _b64(hmac.new(secret.encode(), f"{head}.{body}".encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(sig, expected):
        return None
    claims = json.loads(_unb64(body))
    if int(claims.get("exp", 0)) < time.time():
        return None
    return claims


async def create_user(*, email: str, name: str, password: str, role: str = "admin") -> dict:
    u = User(email=email, name=name, password_hash=hash_password(password), role=role)
    async with session_scope() as s:
        s.add(u)
        await s.flush()
        out = {"id": u.id, "email": u.email, "name": u.name, "role": u.role}
    await audit(actor_kind="system", actor_id="bootstrap", action="user.created",
                resource_kind="user", resource_id=out["id"], reason=email)
    return out


async def login(*, email: str, password: str, ua: str = "", ip: str = "") -> dict:
    async with session_scope() as s:
        u = await s.scalar(select(User).where(User.email == email, User.disabled_at.is_(None)))
        if u is None or not verify_password(password, u.password_hash):
            await audit(actor_kind="user", actor_id=email, action="auth.login_failed",
                        outcome="denied", reason="bad credentials")
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid credentials")
        token = issue_token(u.id, u.role)
        s.add(SessionToken(user_id=u.id, token_hash=hashlib.sha256(token.encode()).hexdigest(),
                           expires_at=_expiry_dt(), ua=ua[:200], ip=ip[:60]))
        out = {"access_token": token, "token_type": "bearer",
               "expires_in": settings.access_token_ttl_min * 60, "user": {"id": u.id, "email": u.email,
                                                                         "name": u.name, "role": u.role}}
    await audit(actor_kind="user", actor_id=u.id, action="auth.login", resource_kind="session")
    return out


def _expiry_dt():
    from datetime import UTC, datetime, timedelta

    return datetime.now(UTC) + timedelta(minutes=settings.access_token_ttl_min)


# ── dependencies ────────────────────────────────────────────────────────────────────
def _extract_token(request: Request, authorization: str | None) -> str | None:
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:]
    qp = request.query_params.get("token")
    return qp


async def require_user(
    request: Request,
    authorization: str | None = Header(default=None),
) -> dict:
    """Every route depends on this (docs/08 §2: default deny; a new router without it fails tests)."""
    if settings.auth_mode == "local":
        return dict(LOCAL_USER)
    token = _extract_token(request, authorization)
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing bearer token")
    claims = decode_token(token)
    if not claims:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid or expired token")
    return {"id": claims["sub"], "role": claims.get("role", "viewer")}


def require_admin(user: dict = Depends(require_user)) -> dict:
    if user.get("role") not in ("admin", "operator"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "admin role required")
    return user


async def authenticate_socket(token: str | None) -> dict | None:
    if settings.auth_mode == "local":
        return dict(LOCAL_USER)
    if not token:
        return None
    claims = decode_token(token)
    return {"id": claims["sub"], "role": claims.get("role", "viewer")} if claims else None


def new_secret(nbytes: int = 32) -> str:
    return secrets.token_urlsafe(nbytes)
