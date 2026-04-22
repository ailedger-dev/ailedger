"""6-gate filter parity with the pasha-dashboard TUI.

These tests pin the gate logic against concrete fixtures so future refactors
can't silently drop a gate.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.config import Config
from app.inbox import list_inbox, mark_read, read_message


def _write(path: Path, body: str = "To: pasha\n\nhi\n") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body)


@pytest.fixture()
def cfg(tmp_path: Path) -> Config:
    box = tmp_path / "publish"
    docs = box / "docs"
    read = tmp_path / "read"
    box.mkdir()
    docs.mkdir()
    read.mkdir()
    return Config(
        slug="pasha",
        jwt_secret="0" * 64,
        publish_box=box,
        activation_date="20260420",
        docs_dir=docs,
        read_dir=read,
        dash_origins=(),
        bind_host="127.0.0.1",
        bind_port=7777,
    )


def test_basic_addressable_hail_included(cfg: Config) -> None:
    _write(cfg.publish_box / "20260421-180000-from-john-welcome.md")
    items = list_inbox(cfg)
    assert [e.id for e in items] == ["20260421-180000-from-john-welcome"]
    assert items[0].from_ == "john"
    assert items[0].subject == "welcome"
    assert items[0].unread is True


def test_gate1_rejects_bad_filename_pattern(cfg: Config) -> None:
    _write(cfg.publish_box / "not-a-hail.md")
    _write(cfg.publish_box / "2026-04-21-from-john-welcome.md")  # wrong date format
    assert list_inbox(cfg) == []


def test_gate2_rejects_non_lowercase_subject(cfg: Config) -> None:
    _write(cfg.publish_box / "20260421-180000-from-john-Welcome.md")
    assert list_inbox(cfg) == []


def test_gate3_rejects_cross_agent_coordination(cfg: Config) -> None:
    for who in ("john", "jo", "bob", "angela", "jake", "mayor"):
        _write(cfg.publish_box / f"20260421-180000-from-john-to-{who}-something.md")
    assert list_inbox(cfg) == []


def test_gate4_rejects_self_messages(cfg: Config) -> None:
    _write(cfg.publish_box / "20260421-180000-from-pasha-note-to-self.md")
    assert list_inbox(cfg) == []


def test_gate5_rejects_pre_activation(cfg: Config) -> None:
    _write(cfg.publish_box / "20260419-180000-from-john-early.md")
    assert list_inbox(cfg) == []


def test_gate6_requires_to_header(cfg: Config) -> None:
    _write(cfg.publish_box / "20260421-180000-from-john-missing-to.md", body="no header\n")
    assert list_inbox(cfg) == []


def test_gate6_audience_or_for_also_works(cfg: Config) -> None:
    _write(cfg.publish_box / "20260421-180000-from-john-via-audience.md", body="Audience: pasha\n")
    _write(cfg.publish_box / "20260421-180000-from-john-via-for.md", body="For: pasha\n")
    ids = {e.id for e in list_inbox(cfg)}
    assert "20260421-180000-from-john-via-audience" in ids
    assert "20260421-180000-from-john-via-for" in ids


def test_gate6_rejects_when_addressed_to_other_contractor(cfg: Config) -> None:
    _write(cfg.publish_box / "20260421-180000-from-john-other.md", body="To: acme\n")
    assert list_inbox(cfg) == []


def test_mark_read_and_unread_state(cfg: Config) -> None:
    _write(cfg.publish_box / "20260421-180000-from-john-hey.md")
    assert list_inbox(cfg)[0].unread is True
    mark_read(cfg, "20260421-180000-from-john-hey")
    assert list_inbox(cfg)[0].unread is False


def test_read_message_path_traversal_blocked(cfg: Config) -> None:
    with pytest.raises(FileNotFoundError):
        read_message(cfg, "../etc/passwd")
    with pytest.raises(FileNotFoundError):
        read_message(cfg, "20260421-180000-from-john-missing")


def test_read_message_rejects_message_not_addressed_to_contractor(cfg: Config) -> None:
    _write(cfg.publish_box / "20260421-180000-from-john-acme.md", body="To: acme\n")
    # It passes the filename regex but fails gate 6 (header). Direct read must reject.
    with pytest.raises(FileNotFoundError):
        read_message(cfg, "20260421-180000-from-john-acme")
