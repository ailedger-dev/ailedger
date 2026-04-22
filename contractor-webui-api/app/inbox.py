"""Port of the pasha-dashboard 6-gate inbox filter to Python, generalized.

Gates (in the TUI's original order):
  1. Filename matches `^YYYYMMDD(-HHMMSS)?-from-<lowercase>-<rest>.md`
  2. Subject segment begins with [a-z0-9]  (policy: lowercase => inbound hail,
     anything else is outbound / tagged / draft)
  3. Subject segment does NOT start with `to-(john|jo|bob|angela|jake|mayor)-`
     (those are cross-agent coordination, not hail-for-this-contractor)
  4. `from-<sender>` != this contractor's slug (don't show self-messages)
  5. File-date >= CONTRACTOR_ACTIVATION_DATE
  6. First 10 lines contain `(To|Audience|For):\\s*<contractor_slug>\\b` (ci)

Read-state: a sentinel file `<read_dir>/<basename>.read`. Opening a message
writes the sentinel; absence = unread.

The read_dir is shared with the TUI dashboard so parity holds when the user
switches between TUI and web (per arch doc §2 v1).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .config import Config

_FNAME_RE = re.compile(
    r"^(?P<date>\d{8})(?:-(?P<time>\d{6}))?-from-(?P<from>[a-z]+)-(?P<subject>.+)\.md$",
)
_BLOCKED_SUBJECT_RE = re.compile(r"^to-(john|jo|bob|angela|jake|mayor)-", re.I)
_LOWER_PREFIX_RE = re.compile(r"^[a-z0-9]")

CROSS_AGENT_NAMES = ("john", "jo", "bob", "angela", "jake", "mayor")


@dataclass(frozen=True)
class InboxEntry:
    id: str              # the file basename without .md extension
    filename: str        # basename with .md
    from_: str
    subject: str         # humanized subject string
    date: str            # ISO 8601 UTC
    unread: bool
    path: str


def _humanize_subject(raw: str) -> str:
    return raw.replace("-", " ").strip()


def _header_addressed_to(path: Path, slug: str) -> bool:
    """Look for `(To|Audience|For): <slug>` in the first 10 lines."""
    needle = re.compile(rf"^(to|audience|for):\s*{re.escape(slug)}\b", re.I)
    try:
        with path.open("r", encoding="utf-8", errors="replace") as f:
            for i, line in enumerate(f):
                if i >= 10:
                    break
                if needle.search(line):
                    return True
    except OSError:
        return False
    return False


def _iso_from_name(date8: str, time6: str | None) -> str:
    ymd = date8
    hms = time6 or "000000"
    try:
        dt = datetime.strptime(ymd + hms, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return f"{ymd}T{hms}Z"
    return dt.isoformat().replace("+00:00", "Z")


def list_inbox(cfg: Config) -> list[InboxEntry]:
    """Return all addressable hails for this contractor (read + unread)."""
    box = cfg.publish_box
    if not box.is_dir():
        return []
    entries: list[InboxEntry] = []
    for path in sorted(box.glob("*.md"), reverse=True):
        base = path.name
        m = _FNAME_RE.match(base)
        if not m:
            continue
        sender = m.group("from")
        subject_raw = m.group("subject")
        date8 = m.group("date")
        time6 = m.group("time")

        if sender == cfg.slug:
            continue
        if not _LOWER_PREFIX_RE.match(subject_raw):
            continue
        if _BLOCKED_SUBJECT_RE.match(subject_raw):
            continue
        if date8 < cfg.activation_date:
            continue
        if not _header_addressed_to(path, cfg.slug):
            continue

        basename_no_ext = base[:-3] if base.endswith(".md") else base
        marker = cfg.read_dir / f"{base}.read"
        entries.append(
            InboxEntry(
                id=basename_no_ext,
                filename=base,
                from_=sender,
                subject=_humanize_subject(subject_raw),
                date=_iso_from_name(date8, time6),
                unread=not marker.exists(),
                path=str(path),
            ),
        )
    return entries


def _resolve_message(cfg: Config, message_id: str) -> Path:
    """Validate message_id and resolve it within the publish_box sandbox.

    Prevents path traversal: message_id must be a pure basename with no slash
    and must match the addressable-hail filename pattern.
    """
    if "/" in message_id or "\\" in message_id or message_id in ("", ".", ".."):
        raise FileNotFoundError(message_id)
    filename = message_id if message_id.endswith(".md") else f"{message_id}.md"
    if not _FNAME_RE.match(filename):
        raise FileNotFoundError(message_id)
    candidate = (cfg.publish_box / filename).resolve()
    try:
        candidate.relative_to(cfg.publish_box)
    except ValueError as e:
        raise FileNotFoundError(message_id) from e
    if not candidate.is_file():
        raise FileNotFoundError(message_id)
    return candidate


def read_message(cfg: Config, message_id: str) -> tuple[Path, InboxEntry]:
    """Return (path, entry) for a single addressable hail, validating it passes
    the same gates `list_inbox` enforces. Enforces slug-level authorization."""
    path = _resolve_message(cfg, message_id)
    m = _FNAME_RE.match(path.name)
    assert m  # guaranteed by _resolve_message
    sender = m.group("from")
    subject_raw = m.group("subject")
    date8 = m.group("date")

    if sender == cfg.slug or not _LOWER_PREFIX_RE.match(subject_raw) or _BLOCKED_SUBJECT_RE.match(subject_raw):
        raise FileNotFoundError(message_id)
    if date8 < cfg.activation_date:
        raise FileNotFoundError(message_id)
    if not _header_addressed_to(path, cfg.slug):
        raise FileNotFoundError(message_id)

    basename_no_ext = path.name[:-3]
    marker = cfg.read_dir / f"{path.name}.read"
    entry = InboxEntry(
        id=basename_no_ext,
        filename=path.name,
        from_=sender,
        subject=_humanize_subject(subject_raw),
        date=_iso_from_name(date8, m.group("time")),
        unread=not marker.exists(),
        path=str(path),
    )
    return path, entry


def mark_read(cfg: Config, message_id: str) -> None:
    path, _ = read_message(cfg, message_id)
    marker = cfg.read_dir / f"{path.name}.read"
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.touch()
