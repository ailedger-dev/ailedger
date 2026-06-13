"""Mirror access for verification — REST reads, archive-dir offline mode,
and multi-mirror cross-checking.

Keyless by design: everything here is public data. The archive format is the
same JSON shape the spike's mirror-dump and the indexer's archiver emit
(``{"messages": [...]}`` of mirror REST rows), so a court bundle is just a
directory of these files plus payloads.

Multi-mirror cross-check: until record-file node-signature validation lands
(needs requester-pays bucket access), independence comes from agreement
between OPERATOR-INDEPENDENT mirrors — same bytes, same sequence numbers,
same consensus timestamps from operators who don't share infrastructure.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import httpx

from ailedger_cli.runninghash import TopicMessage

__all__ = [
    "CrossCheckResult",
    "cross_check",
    "fetch_topic_messages",
    "load_archive",
    "save_archive",
]

DEFAULT_MIRRORS = {
    "testnet": "https://testnet.mirrornode.hedera.com",
    "mainnet": "https://mainnet-public.mirrornode.hedera.com",
}


def fetch_topic_messages(
    mirror_base: str,
    topic_id: str,
    *,
    timeout: float = 30.0,
    transport: httpx.BaseTransport | None = None,
) -> list[TopicMessage]:
    """All messages for a topic via mirror REST, ascending."""
    rows: list[dict] = []
    url = f"{mirror_base.rstrip('/')}/api/v1/topics/{topic_id}/messages?limit=100&order=asc"
    with httpx.Client(timeout=timeout, transport=transport) as client:
        while True:
            res = client.get(url)
            res.raise_for_status()
            body = res.json()
            rows.extend(body.get("messages", []))
            nxt = (body.get("links") or {}).get("next")
            if not nxt:
                break
            url = f"{mirror_base.rstrip('/')}{nxt}"
    return [TopicMessage.from_mirror(r) for r in rows]


def save_archive(path: Path, topic_id: str, raw_rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"topic_id": topic_id, "messages": raw_rows}, indent=1) + "\n",
        encoding="utf-8",
    )


def load_archive(path: Path) -> list[TopicMessage]:
    """Load a mirror-dump/archive JSON file (offline verification input)."""
    dump = json.loads(path.read_text(encoding="utf-8"))
    rows = dump["messages"] if isinstance(dump, dict) else dump
    return [TopicMessage.from_mirror(r) for r in rows]


@dataclass(frozen=True)
class CrossCheckResult:
    agree: bool
    compared: int
    detail: str


def cross_check(a: list[TopicMessage], b: list[TopicMessage]) -> CrossCheckResult:
    """Compare two independent sources for the same topic.

    Agreement = identical message bytes, running hashes, and consensus
    timestamps for every shared sequence number. Sources may have different
    tails (one mirror slightly behind) — only the overlap is compared.
    """
    index_a = {m.sequence_number: m for m in a}
    index_b = {m.sequence_number: m for m in b}
    shared = sorted(set(index_a) & set(index_b))
    if not shared:
        return CrossCheckResult(False, 0, "no overlapping sequence numbers")
    for seq in shared:
        ma, mb = index_a[seq], index_b[seq]
        if ma.message != mb.message:
            return CrossCheckResult(False, len(shared), f"message bytes differ at seq {seq}")
        if ma.running_hash != mb.running_hash:
            return CrossCheckResult(False, len(shared), f"running hash differs at seq {seq}")
        if (ma.seconds, ma.nanos) != (mb.seconds, mb.nanos):
            return CrossCheckResult(False, len(shared), f"consensus timestamp differs at seq {seq}")
    only_a = len(index_a) - len(shared)
    only_b = len(index_b) - len(shared)
    tail = f" (tails: +{only_a}/+{only_b} unshared)" if only_a or only_b else ""
    return CrossCheckResult(True, len(shared), f"{len(shared)} records identical{tail}")
