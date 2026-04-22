"""Per-contractor runtime config.

Loaded from env at startup. The service is generalized over contractors: one
binary, many deployments (or one binary serving one contractor via different
env). For v1 we run one process per contractor bound to localhost.

Required env:
  CONTRACTOR_SLUG            — e.g. 'pasha'. Gates inbox filter + JWT audience.
  CONTRACTOR_JWT_SECRET_FILE — path to HS256 secret file (same bytes the auth
                               worker's SESSION_JWT_SECRET holds).
  CONTRACTOR_PUBLISH_BOX     — absolute path to /srv/town/shared/publish/<slug>/.
  CONTRACTOR_ACTIVATION_DATE — e.g. '20260420'. Inbox gates filter by this.

Optional env:
  CONTRACTOR_DOCS_DIR        — defaults to <publish_box>/docs/.
  CONTRACTOR_READ_DIR        — defaults to ~/.cache/<slug>-dashboard/read/.
  CONTRACTOR_DASH_ORIGIN     — comma-separated CORS allowlist for the dash URL(s).
  BIND_HOST                  — defaults to 127.0.0.1 (never bind publicly; CF
                               tunnel is the public surface).
  BIND_PORT                  — defaults to 7777.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Config:
    slug: str
    jwt_secret: str
    publish_box: Path
    activation_date: str
    docs_dir: Path
    read_dir: Path
    dash_origins: tuple[str, ...]
    bind_host: str
    bind_port: int


def _required(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        raise RuntimeError(f"missing required env var: {name}")
    return v


def load_config() -> Config:
    slug = _required("CONTRACTOR_SLUG").lower().strip()

    secret_file = Path(_required("CONTRACTOR_JWT_SECRET_FILE")).expanduser()
    if not secret_file.is_file():
        raise RuntimeError(f"CONTRACTOR_JWT_SECRET_FILE does not exist: {secret_file}")
    jwt_secret = secret_file.read_text().strip()
    if len(jwt_secret) < 32:
        raise RuntimeError(
            f"CONTRACTOR_JWT_SECRET_FILE content shorter than 32 chars; "
            f"this must be the same bytes the auth worker's SESSION_JWT_SECRET holds",
        )

    publish_box = Path(_required("CONTRACTOR_PUBLISH_BOX")).expanduser().resolve()
    if not publish_box.is_dir():
        raise RuntimeError(f"CONTRACTOR_PUBLISH_BOX is not a directory: {publish_box}")

    activation_date = _required("CONTRACTOR_ACTIVATION_DATE").strip()
    if not (len(activation_date) == 8 and activation_date.isdigit()):
        raise RuntimeError(
            f"CONTRACTOR_ACTIVATION_DATE must be YYYYMMDD, got: {activation_date!r}",
        )

    docs_dir_env = os.environ.get("CONTRACTOR_DOCS_DIR")
    docs_dir = Path(docs_dir_env).expanduser().resolve() if docs_dir_env else publish_box / "docs"

    read_dir_env = os.environ.get("CONTRACTOR_READ_DIR")
    read_dir = (
        Path(read_dir_env).expanduser()
        if read_dir_env
        else Path.home() / ".cache" / f"{slug}-dashboard" / "read"
    )
    read_dir.mkdir(parents=True, exist_ok=True)

    dash_origins = tuple(
        o.strip()
        for o in os.environ.get("CONTRACTOR_DASH_ORIGIN", "").split(",")
        if o.strip()
    )

    bind_host = os.environ.get("BIND_HOST", "127.0.0.1")
    bind_port = int(os.environ.get("BIND_PORT", "7777"))

    return Config(
        slug=slug,
        jwt_secret=jwt_secret,
        publish_box=publish_box,
        activation_date=activation_date,
        docs_dir=docs_dir,
        read_dir=read_dir,
        dash_origins=dash_origins,
        bind_host=bind_host,
        bind_port=bind_port,
    )
