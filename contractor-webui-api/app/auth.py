"""JWT session validation. Mirrors the contractor-auth Worker's issueSessionJwt.

The Worker signs HS256 with SESSION_JWT_SECRET. We verify with the same bytes,
then require aud == contractor_slug + iss == 'contractor-auth'. Strict:
tokens from a different contractor are rejected.

Tokens arrive via the `session` cookie (httpOnly, set first-party on the
contractor's dash domain). The Cloudflare Tunnel forwards the cookie when the
browser requests api.<contractor>.jvholdings.co with credentials.
"""

from __future__ import annotations

from typing import Any

import jwt
from fastapi import Cookie, Depends, HTTPException, status

from .config import Config, load_config

_config: Config | None = None


def get_config() -> Config:
    global _config
    if _config is None:
        _config = load_config()
    return _config


def verify_session_jwt(token: str, cfg: Config) -> dict[str, Any]:
    try:
        payload = jwt.decode(
            token,
            cfg.jwt_secret,
            algorithms=["HS256"],
            audience=cfg.slug,
            issuer="contractor-auth",
            options={"require": ["exp", "iat", "aud", "iss", "sub"]},
        )
    except jwt.InvalidAudienceError as e:
        raise HTTPException(status.HTTP_403_FORBIDDEN, f"audience_mismatch") from e
    except jwt.ExpiredSignatureError as e:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "expired") from e
    except jwt.InvalidTokenError as e:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, f"invalid_token") from e

    if payload.get("contractor") != cfg.slug:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "contractor_mismatch")
    return payload


async def current_user(
    session: str | None = Cookie(default=None),
    cfg: Config = Depends(get_config),
) -> dict[str, Any]:
    if not session:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "no_session")
    return verify_session_jwt(session, cfg)
