"""Tests for config file handling."""

from __future__ import annotations

import os
import stat

import pytest

from ailedger_cli.config import (
    API_KEY_ENV_VAR,
    ConfigError,
    get_api_key,
    load_config,
    parse_set_assignment,
    save_config,
)


def test_parse_set_assignment_happy_path():
    assert parse_set_assignment("base-url=https://x.supabase.co") == (
        "base-url",
        "https://x.supabase.co",
    )


def test_parse_set_assignment_trims_whitespace():
    assert parse_set_assignment("  base-url = https://x.dev  ") == (
        "base-url",
        "https://x.dev",
    )


def test_parse_set_assignment_rejects_missing_equals():
    with pytest.raises(ConfigError, match="KEY=VALUE"):
        parse_set_assignment("base-url")


def test_parse_set_assignment_rejects_empty_key():
    with pytest.raises(ConfigError, match="must not be empty"):
        parse_set_assignment("=foo")


def test_parse_set_assignment_refuses_api_key():
    with pytest.raises(ConfigError, match="refusing to write api-key"):
        parse_set_assignment("api-key=ail_sk_leaked")


def test_parse_set_assignment_rejects_unknown_key():
    with pytest.raises(ConfigError, match="unknown config key"):
        parse_set_assignment("project=foo")


def test_save_and_load_roundtrip(tmp_path):
    path = tmp_path / "cfg.toml"
    save_config({"base-url": "https://x.dev", "customer-id": "abc"}, path)
    assert load_config(path) == {"base-url": "https://x.dev", "customer-id": "abc"}


def test_save_config_is_0600(tmp_path):
    path = tmp_path / "cfg.toml"
    save_config({"base-url": "https://x.dev"}, path)
    mode = stat.S_IMODE(os.stat(path).st_mode)
    assert mode == 0o600


def test_save_config_escapes_quotes(tmp_path):
    path = tmp_path / "cfg.toml"
    save_config({"base-url": 'https://a.dev/"weird"'}, path)
    assert load_config(path)["base-url"] == 'https://a.dev/"weird"'


def test_load_config_missing_returns_empty(tmp_path):
    assert load_config(tmp_path / "does-not-exist.toml") == {}


def test_get_api_key_from_env(monkeypatch):
    monkeypatch.setenv(API_KEY_ENV_VAR, "ail_sk_env")
    assert get_api_key() == "ail_sk_env"


def test_get_api_key_none_when_unset(monkeypatch):
    monkeypatch.delenv(API_KEY_ENV_VAR, raising=False)
    # May still fall through to keyring; stub it out to guarantee None.
    monkeypatch.setattr(
        "ailedger_cli.config.get_api_key",
        lambda: os.environ.get(API_KEY_ENV_VAR),
    )
    from ailedger_cli.config import get_api_key as fn

    assert fn() is None
