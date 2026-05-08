"""Reading-room docs: the `docs/` subfolder of the contractor's publish box.

No filtering other than `*.md` — these are references the mayor has intentionally
placed in the contractor's reading room.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from .config import Config


@dataclass(frozen=True)
class DocEntry:
    id: str
    filename: str
    title: str
    path: str


def _title_from(path: Path) -> str:
    # Prefer first `#` heading if the file starts with one; fall back to filename.
    try:
        with path.open("r", encoding="utf-8", errors="replace") as f:
            for i, line in enumerate(f):
                if i >= 5:
                    break
                m = re.match(r"^#\s+(.+?)\s*$", line)
                if m:
                    return m.group(1)
    except OSError:
        pass
    stem = path.stem
    return stem.replace("-", " ")


def list_docs(cfg: Config) -> list[DocEntry]:
    dir_ = cfg.docs_dir
    if not dir_.is_dir():
        return []
    out: list[DocEntry] = []
    for path in sorted(dir_.glob("*.md"), key=lambda p: p.stat().st_mtime, reverse=True):
        out.append(
            DocEntry(
                id=path.stem,
                filename=path.name,
                title=_title_from(path),
                path=str(path),
            ),
        )
    return out


def _resolve_doc(cfg: Config, doc_id: str) -> Path:
    if "/" in doc_id or "\\" in doc_id or doc_id in ("", ".", ".."):
        raise FileNotFoundError(doc_id)
    filename = doc_id if doc_id.endswith(".md") else f"{doc_id}.md"
    candidate = (cfg.docs_dir / filename).resolve()
    try:
        candidate.relative_to(cfg.docs_dir)
    except ValueError as e:
        raise FileNotFoundError(doc_id) from e
    if not candidate.is_file():
        raise FileNotFoundError(doc_id)
    return candidate


def read_doc(cfg: Config, doc_id: str) -> tuple[Path, DocEntry]:
    path = _resolve_doc(cfg, doc_id)
    return path, DocEntry(
        id=path.stem,
        filename=path.name,
        title=_title_from(path),
        path=str(path),
    )
