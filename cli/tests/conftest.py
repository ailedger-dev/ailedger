"""Shared pytest fixtures."""

from __future__ import annotations

from collections.abc import Iterator

import pytest

from ailedger_cli import config as config_mod


@pytest.fixture
def tmp_config(tmp_path, monkeypatch) -> Iterator:
    """Redirect the CLI's config path to a per-test temp file.

    Also clears ``AILEDGER_API_KEY`` and ``AILEDGER_CHAIN_ENABLED`` so tests
    start from a known environment.
    """
    cfg = tmp_path / "config.toml"
    monkeypatch.setenv(config_mod.CONFIG_ENV_VAR, str(cfg))
    monkeypatch.delenv(config_mod.API_KEY_ENV_VAR, raising=False)
    monkeypatch.delenv("AILEDGER_CHAIN_ENABLED", raising=False)
    yield cfg
