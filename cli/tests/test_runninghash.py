"""Structural tests for ailedger_cli.runninghash.

These lock the plumbing (mirror-row parsing, chain walking, layout
discrimination) with synthetic data. The ground truth for WHICH layout the
network uses comes from running the detector against a live mirror dump
(proxy spike: `spike-hcs.mts mirror-dump`) — recorded in the Phase 0 ADR.
"""

from __future__ import annotations

import base64

from ailedger_cli.runninghash import (
    GENESIS,
    LAYOUTS,
    Layout,
    TopicMessage,
    detect_layout,
    step,
)

_TOPIC = (0, 0, 4242)


def _synthetic_chain(layout: Layout, count: int, start_seq: int = 1) -> list[TopicMessage]:
    """Build a chain whose running hashes are self-consistent under *layout*."""
    messages: list[TopicMessage] = []
    prev = GENESIS
    for i in range(count):
        seq = start_seq + i
        partial = TopicMessage(
            topic_id=_TOPIC,
            payer_id=(0, 0, 1001 + i % 3),
            seconds=1_780_000_000 + i,
            nanos=123_456_789 + i,
            sequence_number=seq,
            message=f"payload-{seq}".encode(),
            running_hash=b"",  # filled below
            running_hash_version=3,
        )
        rh = step(prev, partial, layout)
        msg = TopicMessage(
            topic_id=partial.topic_id,
            payer_id=partial.payer_id,
            seconds=partial.seconds,
            nanos=partial.nanos,
            sequence_number=partial.sequence_number,
            message=partial.message,
            running_hash=rh,
            running_hash_version=3,
        )
        messages.append(msg)
        prev = rh
    return messages


def test_detector_identifies_exactly_the_generating_layout() -> None:
    for layout in LAYOUTS:
        chain = _synthetic_chain(layout, count=6)
        results = detect_layout(chain)
        full_matches = [name for name, (m, c) in results.items() if c and m == c]
        assert full_matches == [layout.name]


def test_mid_chain_dump_skips_unverifiable_first_row() -> None:
    layout = LAYOUTS[0]
    chain = _synthetic_chain(layout, count=5, start_seq=10)
    results = detect_layout(chain)
    matches, checks = results[layout.name]
    # First row (seq 10) has no known predecessor: 4 checks, all matching.
    assert (matches, checks) == (4, 4)


def test_from_mirror_parses_rest_row() -> None:
    row = {
        "consensus_timestamp": "1780000000.123456789",
        "topic_id": "0.0.4242",
        "payer_account_id": "0.0.1001",
        "sequence_number": 7,
        "message": base64.b64encode(b"hello").decode(),
        "running_hash": base64.b64encode(bytes(48)).decode(),
        "running_hash_version": 3,
    }
    msg = TopicMessage.from_mirror(row)
    assert msg.topic_id == (0, 0, 4242)
    assert msg.payer_id == (0, 0, 1001)
    assert msg.seconds == 1_780_000_000
    assert msg.nanos == 123_456_789
    assert msg.sequence_number == 7
    assert msg.message == b"hello"
    assert len(msg.running_hash) == 48
