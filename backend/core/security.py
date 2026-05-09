"""JWT token creation and verification for staff authentication, plus device-token gating."""

import hmac
from datetime import datetime, timedelta, timezone

from fastapi import Depends, Header, HTTPException, Query
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import jwt

from config import settings

ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 480  # 8-hour shift

_bearer_scheme = HTTPBearer(auto_error=True)


def create_access_token(data: dict) -> str:
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, settings.secret_key, algorithm=ALGORITHM)


def verify_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM])
    except Exception:
        return None


async def verify_device_token(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer_scheme),
) -> str:
    """FastAPI dependency that validates a Pi device token from the Authorization header.

    Raises 503 when no tokens are configured (fail-closed).
    Raises 401 on token mismatch.
    Returns the matched token string on success.
    """
    valid_tokens = settings.device_tokens_set
    if not valid_tokens:
        raise HTTPException(status_code=503, detail="Device auth not configured")

    candidate = credentials.credentials
    for token in valid_tokens:
        if hmac.compare_digest(candidate, token):
            return token

    raise HTTPException(status_code=401, detail="Invalid device token")


async def verify_device_api_key(
    x_device_api_key: str | None = Header(default=None),
    key: str | None = Query(default=None),
) -> None:
    """FastAPI dependency for /api/device/* — frontend -> ngrok -> Pi.

    Accepts EITHER:
      * X-Device-API-Key header  (preferred — used by fetch())
      * ?key=...  query param    (used by browser <img> tags for the
                                   MJPEG streaming endpoint, where headers
                                   can't be set)

    Same fail-closed posture: 503 when unconfigured, 401 on mismatch.
    The query-param path is a soft secret (URL leaks to browser history,
    server logs); pair with HTTPS-only ngrok and short-lived URLs in prod.
    """
    expected = settings.device_api_key
    if not expected:
        raise HTTPException(status_code=503, detail="Device API key not configured")
    candidate = x_device_api_key or key
    if not candidate or not hmac.compare_digest(candidate, expected):
        raise HTTPException(status_code=401, detail="Invalid device API key")
