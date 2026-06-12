"""HCS topic running-hash (version 3) recompute with layout auto-detection.

Hedera consensus nodes maintain a SHA-384 running hash per topic; mirror
nodes report it per message (``running_hash``, ``running_hash_version``).
Recomputing it from message data is the operator-independent integrity check
at the heart of verifier v2 — but the exact byte layout of the v3 preimage is
not stated in the public docs (gap recorded in the Phase 0 ADR).

This module therefore implements the candidate layouts and *detects* the one
that matches live network data. The logical fields are:

    previous_running_hash (48 bytes)
    version               (int64 BE, = 3)
    [payer shard/realm/num   (3 × int64 BE)]        # candidate dimension
    topic shard/realm/num    (3 × int64 BE)
    consensus seconds        (int64 BE)
    consensus nanos          (int32 or int64 BE)    # candidate dimension
    sequence_number          (int64 BE)
    SHA384(message)          (48 bytes)

…and the framing is a candidate dimension too: consensus nodes build the
preimage with Java's ObjectOutputStream (stream header ``ACED0005``,
``TC_ARRAY``/``TC_CLASSDESC`` framing around the two byte arrays, primitives
coalesced into a ``TC_BLOCKDATA`` chunk), not raw concatenation. Empirical
verdict against mainnet topic 0.0.368908: **java-object-stream / payer
included / nanos int32** matches; all raw-concatenation variants fail.

Validation walks a mirror-node dump (``spike-hcs.mts mirror-dump`` output):
for every adjacent pair, recompute message N's hash from message N-1's
reported hash — so a dump need not start at sequence 1. When it does, the
genesis link (previous = 48 zero bytes) is checked too.

Usage: python -m ailedger_cli.runninghash <mirror-dump.json>
"""

from __future__ import annotations

import base64
import hashlib
import json
import struct
import sys
from dataclasses import dataclass

__all__ = ["Layout", "LAYOUTS", "TopicMessage", "step", "detect_layout"]

GENESIS = bytes(48)
RUNNING_HASH_VERSION = 3

# Java ObjectOutputStream framing constants (java.io.ObjectStreamConstants).
_JOS_HEADER = bytes.fromhex("aced0005")  # STREAM_MAGIC + STREAM_VERSION
# TC_CLASSDESC for byte[]: classname "[B", serialVersionUID, SC_SERIALIZABLE,
# zero fields, TC_ENDBLOCKDATA, TC_NULL superclass.
_JOS_BYTE_ARRAY_CLASSDESC = bytes.fromhex("7200025b42acf317f8060854e00200007870")
_JOS_TC_ARRAY = b"\x75"
# Second byte[] reuses the class descriptor via TC_REFERENCE to handle 0x7E0000.
_JOS_CLASSDESC_REF = b"\x71\x00\x7e\x00\x00"
_JOS_TC_BLOCKDATA = b"\x77"


@dataclass(frozen=True)
class Layout:
    """One candidate preimage layout."""

    java_object_stream: bool
    includes_payer: bool
    nanos_int64: bool

    @property
    def name(self) -> str:
        framing = "jos" if self.java_object_stream else "raw"
        payer = "payer" if self.includes_payer else "no-payer"
        nanos = "nanos-i64" if self.nanos_int64 else "nanos-i32"
        return f"v3/{framing}/{payer}/{nanos}"


LAYOUTS = [
    Layout(java_object_stream=j, includes_payer=p, nanos_int64=n)
    for j in (True, False)
    for p in (True, False)
    for n in (True, False)
]


@dataclass(frozen=True)
class TopicMessage:
    """The fields of a mirror REST topic message needed for recompute."""

    topic_id: tuple[int, int, int]
    payer_id: tuple[int, int, int]
    seconds: int
    nanos: int
    sequence_number: int
    message: bytes
    running_hash: bytes
    running_hash_version: int

    @classmethod
    def from_mirror(cls, row: dict) -> TopicMessage:
        ts_s, _, ts_n = row["consensus_timestamp"].partition(".")
        return cls(
            topic_id=_entity(row["topic_id"]),
            payer_id=_entity(row["payer_account_id"]),
            seconds=int(ts_s),
            nanos=int(ts_n or 0),
            sequence_number=int(row["sequence_number"]),
            message=base64.b64decode(row["message"]),
            running_hash=base64.b64decode(row["running_hash"]),
            running_hash_version=int(row.get("running_hash_version", RUNNING_HASH_VERSION)),
        )


def _entity(entity: str) -> tuple[int, int, int]:
    shard, realm, num = entity.split(".")
    return int(shard), int(realm), int(num)


def _primitives(msg: TopicMessage, layout: Layout) -> bytes:
    buf = bytearray()
    buf += struct.pack(">q", RUNNING_HASH_VERSION)
    if layout.includes_payer:
        buf += struct.pack(">qqq", *msg.payer_id)
    buf += struct.pack(">qqq", *msg.topic_id)
    buf += struct.pack(">q", msg.seconds)
    buf += struct.pack(">q" if layout.nanos_int64 else ">i", msg.nanos)
    buf += struct.pack(">q", msg.sequence_number)
    return bytes(buf)


def step(prev: bytes, msg: TopicMessage, layout: Layout) -> bytes:
    """Compute the running hash after *msg*, given the hash before it."""
    digest = hashlib.sha384(msg.message).digest()
    prims = _primitives(msg, layout)
    if not layout.java_object_stream:
        preimage = prev + prims + digest
        return hashlib.sha384(preimage).digest()
    # Replicate java.io.ObjectOutputStream byte-for-byte:
    #   writeObject(prev)  → TC_ARRAY + full classdesc (first occurrence)
    #   writeLong/Int…     → one TC_BLOCKDATA chunk (primitives coalesce)
    #   writeObject(digest)→ TC_ARRAY + TC_REFERENCE to the byte[] classdesc
    assert len(prims) < 256, "block-data short form only"
    preimage = (
        _JOS_HEADER
        + _JOS_TC_ARRAY
        + _JOS_BYTE_ARRAY_CLASSDESC
        + struct.pack(">i", len(prev))
        + prev
        + _JOS_TC_BLOCKDATA
        + bytes([len(prims)])
        + prims
        + _JOS_TC_ARRAY
        + _JOS_CLASSDESC_REF
        + struct.pack(">i", len(digest))
        + digest
    )
    return hashlib.sha384(preimage).digest()


def detect_layout(messages: list[TopicMessage]) -> dict[str, tuple[int, int]]:
    """Try every candidate layout; return {layout name: (matches, checks)}."""
    results: dict[str, tuple[int, int]] = {}
    for layout in LAYOUTS:
        matches = checks = 0
        for i, msg in enumerate(messages):
            if i > 0:
                prev = messages[i - 1].running_hash
            elif msg.sequence_number == 1:
                prev = GENESIS
            else:
                continue  # mid-chain dump: first row has no known predecessor
            checks += 1
            if step(prev, msg, layout) == msg.running_hash:
                matches += 1
        results[layout.name] = (matches, checks)
    return results


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: python -m ailedger_cli.runninghash <mirror-dump.json>", file=sys.stderr)
        return 2
    with open(argv[1], encoding="utf-8") as f:
        dump = json.load(f)
    rows = dump["messages"] if isinstance(dump, dict) else dump
    messages = sorted(
        (TopicMessage.from_mirror(r) for r in rows), key=lambda m: m.sequence_number
    )
    if not messages:
        print("no messages in dump", file=sys.stderr)
        return 2
    non_v3 = {m.running_hash_version for m in messages} - {RUNNING_HASH_VERSION}
    if non_v3:
        print(f"WARNING: non-v3 running_hash_version values present: {sorted(non_v3)}")
    results = detect_layout(messages)
    winners = []
    for name, (matches, checks) in sorted(results.items()):
        verdict = "MATCH" if checks and matches == checks else ""
        print(f"{name:24s} {matches}/{checks} {verdict}")
        if checks and matches == checks:
            winners.append(name)
    if len(winners) == 1:
        print(f"\ndetected layout: {winners[0]} over {len(messages)} messages")
        return 0
    if winners:
        print(f"\nambiguous: {winners} — need a larger dump")
        return 1
    print("\nno layout matched — algorithm assumption wrong; record in ADR")
    return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main(sys.argv))
