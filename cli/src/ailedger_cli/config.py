"""Config file + secret handling for ailedger-cli.

Config (plain text) lives at ``~/.config/ailedger/config.toml`` and holds
non-sensitive values: ``base-url``, ``customer-id``, etc.

Secrets (api-key) are **never** written to the config file. They must come
from either the ``AILEDGER_API_KEY`` environment variable or the OS keyring
(optional ``keyring`` extra).
"""

from __future__ import annotations

import os
import re
import tomllib
from collections.abc import Mapping
from pathlib import Path

CONFIG_ENV_VAR = "AILEDGER_CONFIG"
API_KEY_ENV_VAR = "AILEDGER_API_KEY"
KEYRING_SERVICE = "ailedger-cli"
KEYRING_USERNAME = "api-key"

# Keys that must never hit disk via the config file.
SECRET_KEYS: frozenset[str] = frozenset({"api-key", "api_key"})

# Keys allowed in config.toml. Keep the list tight so typos surface early.
ALLOWED_CONFIG_KEYS: frozenset[str] = frozenset(
    {"base-url", "customer-id", "timeout-seconds"}
)


class ConfigError(Exception):
    """Raised when a user-supplied config value is invalid."""


def default_config_path() -> Path:
    """Return the canonical config path, respecting ``$AILEDGER_CONFIG``."""
    override = os.environ.get(CONFIG_ENV_VAR)
    if override:
        return Path(override).expanduser()
    xdg = os.environ.get("XDG_CONFIG_HOME")
    base = Path(xdg).expanduser() if xdg else Path.home() / ".config"
    return base / "ailedger" / "config.toml"


def load_config(path: Path | None = None) -> dict[str, str]:
    """Load a flat ``{key: value}`` dict from the config file.

    Missing file → empty dict. Non-string values are coerced to ``str``.
    """
    path = path or default_config_path()
    if not path.exists():
        return {}
    with path.open("rb") as fh:
        raw = tomllib.load(fh)
    return {str(k): str(v) for k, v in raw.items() if not isinstance(v, Mapping)}


def save_config(values: Mapping[str, str], path: Path | None = None) -> Path:
    """Write ``values`` to the config file (0600)."""
    path = path or default_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    body = _render_toml(values)
    # Write then chmod to avoid a race where the file is briefly world-readable.
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(body, encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    return path


def parse_set_assignment(assignment: str) -> tuple[str, str]:
    """Parse ``KEY=VALUE`` used by ``config --set``.

    Raises :class:`ConfigError` for empty keys, missing ``=``, secret keys,
    or keys outside :data:`ALLOWED_CONFIG_KEYS`.
    """
    if "=" not in assignment:
        raise ConfigError(
            f"--set expects KEY=VALUE, got {assignment!r}. "
            "Example: --set base-url=https://proxy.ailedger.dev"
        )
    key, value = assignment.split("=", 1)
    key = key.strip().lower()
    value = value.strip()
    if not key:
        raise ConfigError("config key must not be empty")
    if key in SECRET_KEYS:
        raise ConfigError(
            "refusing to write api-key to config.toml. "
            "Use --set-secret api-key (keyring extra) or the "
            f"{API_KEY_ENV_VAR} env var."
        )
    if key not in ALLOWED_CONFIG_KEYS:
        allowed = ", ".join(sorted(ALLOWED_CONFIG_KEYS))
        raise ConfigError(f"unknown config key {key!r}. Allowed: {allowed}")
    return key, value


def get_api_key() -> str | None:
    """Return the API key, or ``None`` if not configured.

    Resolution order:
      1. ``AILEDGER_API_KEY`` env var
      2. OS keyring (``keyring`` extra)
    """
    env = os.environ.get(API_KEY_ENV_VAR)
    if env:
        return env
    try:  # pragma: no cover - exercised when the extra is installed
        import keyring
    except ImportError:
        return None
    try:  # pragma: no cover - environment-dependent
        return keyring.get_password(KEYRING_SERVICE, KEYRING_USERNAME)
    except Exception:
        return None


def set_api_key(value: str) -> str:
    """Store ``value`` in the OS keyring. Returns a human-readable backend name.

    Raises :class:`ConfigError` when the ``keyring`` extra is not installed.
    """
    try:  # pragma: no cover - requires the extra
        import keyring
    except ImportError as exc:
        raise ConfigError(
            "storing the api-key requires the 'keyring' extra. "
            "Install with: pip install 'ailedger-cli[keyring]'. "
            f"Or set the {API_KEY_ENV_VAR} environment variable."
        ) from exc
    keyring.set_password(KEYRING_SERVICE, KEYRING_USERNAME, value)  # pragma: no cover
    backend = getattr(keyring.get_keyring(), "__class__", type("x", (), {})).__name__
    return backend  # pragma: no cover


_TOML_SAFE = re.compile(r"^[A-Za-z0-9_\-]+$")


def _render_toml(values: Mapping[str, str]) -> str:
    """Render a flat mapping as TOML. Stdlib has no writer, so we roll our own.

    Only simple string values are supported, which matches the allow-list.
    """
    lines: list[str] = []
    for key in sorted(values):
        value = values[key]
        # Quote keys containing dashes to keep TOML valid.
        toml_key = key if _TOML_SAFE.match(key) and "-" not in key else f'"{key}"'
        escaped = value.replace("\\", "\\\\").replace('"', '\\"')
        lines.append(f'{toml_key} = "{escaped}"')
    return "\n".join(lines) + ("\n" if lines else "")
