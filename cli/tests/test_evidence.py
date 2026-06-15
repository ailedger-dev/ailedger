"""Verifier-v2 core tests — merkle parity, topic verification on synthetic
chains, manifest + commitment checks, multi-mirror cross-check."""

from __future__ import annotations

import base64
import hashlib
import json
from typing import Any

from ailedger_cli.canonical import canonical
from ailedger_cli.evidence import (
    GENESIS_PREV,
    commit_field,
    compute_checkpoint_root,
    verify_batch_manifest,
    verify_checkpoint_manifest,
    verify_commitments,
    verify_genesis_witness,
    verify_topic,
)
from ailedger_cli.merkle import inclusion_proof, leaf_hash, merkle_root, verify_inclusion
from ailedger_cli.mirror import cross_check
from ailedger_cli.runninghash import GENESIS, LAYOUTS, TopicMessage, step

_JOS = next(lay for lay in LAYOUTS if lay.name == "v3/jos/payer/nanos-i32")
_TOPIC = (0, 0, 9218174)
_SALT = bytes(range(32))


# --- fixture: a self-consistent topic (network hash + app chain) -------------


def _record_bytes(kind: str, prev_hash: str, n: int, salt: bytes = _SALT) -> bytes:
    if kind == "ode-2":
        body: dict[str, Any] = {
            "v": "ode-2",
            "profile": "lean",
            "event_id": f"00000000-0000-4000-8000-{n:012d}",
            "decision_type": "employment_screening",
            "ts": f"2026-06-12T20:00:0{n}.000Z",
            "prev_hash": prev_hash,
            "human_in_loop": False,
            "model_weights_hash": None,
            "inputs_commit": commit_field(salt, "inputs", {"n": n}),
            "output_commit": commit_field(salt, "output", {"decision": "advance"}),
            "context_commit": commit_field(salt, "context", None),
            "actions_commit": commit_field(salt, "actions", None),
            "trace_commit": None,
            "payload_hash": "cd" * 32,
        }
    else:
        logs = [{"call": i} for i in range(3)]
        body = {
            "v": "ode-2b",
            "batch_id": f"batch-{n}",
            "prev_hash": prev_hash,
            "merkle_root": merkle_root([canonical(log).encode() for log in logs]).hex(),
            "leaf_count": 3,
            "range": {"from_ts": "a", "to_ts": "b"},
            "leaf_spec": "rfc6962-sha256/jcs-v1",
        }
    return canonical(body).encode("utf-8")


def make_topic(kinds: list[str]) -> list[TopicMessage]:
    messages: list[TopicMessage] = []
    prev_app = GENESIS_PREV
    prev_rh = GENESIS
    for i, kind in enumerate(kinds):
        raw = _record_bytes(kind, prev_app, i + 1)
        partial = TopicMessage(
            topic_id=_TOPIC,
            payer_id=(0, 0, 9185779),
            seconds=1_781_300_000 + i,
            nanos=i,
            sequence_number=i + 1,
            message=raw,
            running_hash=b"",
            running_hash_version=3,
        )
        rh = step(prev_rh, partial, _JOS)
        messages.append(
            TopicMessage(
                topic_id=partial.topic_id,
                payer_id=partial.payer_id,
                seconds=partial.seconds,
                nanos=partial.nanos,
                sequence_number=partial.sequence_number,
                message=raw,
                running_hash=rh,
                running_hash_version=3,
            )
        )
        prev_app = hashlib.sha256(raw).hexdigest()
        prev_rh = rh
    return messages


# --- fixture: a checkpoint topic (chk-1 over tenant heads) -------------------

_HEADS = [
    {"topic_id": "0.0.200", "sequence_number": 7, "running_hash": "ab" * 48},
    {"topic_id": "0.0.30", "sequence_number": 3, "running_hash": "cd" * 48},
]


def _checkpoint_topic(tenant_root: str, tenant_count: int) -> list[TopicMessage]:
    """A single chk-1 record, running-hash chained from genesis."""
    body = {
        "v": "chk-1",
        "prev_hash": GENESIS_PREV,
        "ts": "2026-06-14T00:00:00.000Z",
        "period": {"from_ts": "genesis", "to_ts": "2026-06-14T00:00:00.000Z"},
        "tenant_root": tenant_root,
        "tenant_count": tenant_count,
        "leaf_spec": "rfc6962-sha256/jcs-tenant-head-v1",
    }
    raw = canonical(body).encode("utf-8")
    partial = TopicMessage(
        topic_id=_TOPIC,
        payer_id=(0, 0, 9185779),
        seconds=1_781_300_000,
        nanos=0,
        sequence_number=1,
        message=raw,
        running_hash=b"",
        running_hash_version=3,
    )
    rh = step(GENESIS, partial, _JOS)
    return [
        TopicMessage(
            topic_id=partial.topic_id,
            payer_id=partial.payer_id,
            seconds=partial.seconds,
            nanos=partial.nanos,
            sequence_number=1,
            message=raw,
            running_hash=rh,
            running_hash_version=3,
        )
    ]


def test_checkpoint_root_is_order_independent_and_numeric() -> None:
    # 0.0.30 sorts before 0.0.200 numerically; input order must not matter.
    assert compute_checkpoint_root(_HEADS) == compute_checkpoint_root(list(reversed(_HEADS)))


def test_checkpoint_manifest_verifies_against_onchain_root() -> None:
    root = compute_checkpoint_root(_HEADS)
    report = verify_topic("0.0.9218174", _checkpoint_topic(root, len(_HEADS)))
    verify_checkpoint_manifest(report, {"kind": "checkpoint", "tenant_root": root, "heads": _HEADS})
    finding = next(f for f in report.findings if f.check == "checkpoint")
    assert finding.level == "PASS", finding.detail
    assert report.ok


def test_checkpoint_manifest_detects_internal_tamper() -> None:
    # Heads swapped under an unchanged claimed root ⇒ recompute disagrees.
    root = compute_checkpoint_root(_HEADS)
    report = verify_topic("0.0.9218174", _checkpoint_topic(root, len(_HEADS)))
    tampered = [dict(_HEADS[0], running_hash="ff" * 48), _HEADS[1]]
    verify_checkpoint_manifest(report, {"kind": "checkpoint", "tenant_root": root, "heads": tampered})
    finding = next(f for f in report.findings if f.check == "checkpoint")
    assert finding.level == "FAIL"
    assert "disagrees with recompute" in finding.detail
    assert not report.ok


def test_checkpoint_manifest_rejects_root_absent_on_chain() -> None:
    # Internally consistent manifest describing a DIFFERENT estate ⇒ no chk-1
    # on this topic carries that root.
    on_chain_root = compute_checkpoint_root(_HEADS)
    report = verify_topic("0.0.9218174", _checkpoint_topic(on_chain_root, len(_HEADS)))
    other_heads = [dict(_HEADS[0], running_hash="ff" * 48), _HEADS[1]]
    other_root = compute_checkpoint_root(other_heads)
    verify_checkpoint_manifest(
        report, {"kind": "checkpoint", "tenant_root": other_root, "heads": other_heads}
    )
    finding = next(f for f in report.findings if f.check == "checkpoint")
    assert finding.level == "FAIL"
    assert "no on-chain" in finding.detail


# --- fixture: a genesis topic (gen-1 witnessing a predecessor) ---------------


def _witness_for(pred: list[TopicMessage]) -> dict[str, Any]:
    last = max(pred, key=lambda m: m.sequence_number)
    return {
        "kind": "hcs-continuity",
        "predecessor_topic_id": "0.0.9218174",
        "final_seq": last.sequence_number,
        "final_running_hash": last.running_hash.hex(),
        "final_app_head": hashlib.sha256(last.message).hexdigest(),
        "record_count": last.sequence_number,
    }


def _genesis_topic(witness: dict[str, Any]) -> list[TopicMessage]:
    raw = canonical(
        {"v": "gen-1", "prev_hash": GENESIS_PREV, "ts": "2026-06-14T00:00:00.000Z", "witness": witness}
    ).encode("utf-8")
    partial = TopicMessage(
        topic_id=_TOPIC,
        payer_id=(0, 0, 9185779),
        seconds=1_781_300_000,
        nanos=0,
        sequence_number=1,
        message=raw,
        running_hash=b"",
        running_hash_version=3,
    )
    rh = step(GENESIS, partial, _JOS)
    return [
        TopicMessage(
            topic_id=partial.topic_id,
            payer_id=partial.payer_id,
            seconds=partial.seconds,
            nanos=partial.nanos,
            sequence_number=1,
            message=raw,
            running_hash=rh,
            running_hash_version=3,
        )
    ]


def test_genesis_witness_matches_predecessor() -> None:
    pred = make_topic(["ode-2", "ode-2", "ode-2b"])
    report = verify_topic("0.0.mainnet", _genesis_topic(_witness_for(pred)))
    verify_genesis_witness(report, pred)
    finding = next(f for f in report.findings if f.check == "genesis")
    assert finding.level == "PASS", finding.detail
    assert report.ok


def test_genesis_witness_detects_forged_continuity() -> None:
    pred = make_topic(["ode-2", "ode-2", "ode-2b"])
    forged = _witness_for(pred)
    forged["final_app_head"] = "00" * 32  # claims a predecessor head that isn't real
    report = verify_topic("0.0.mainnet", _genesis_topic(forged))
    verify_genesis_witness(report, pred)
    finding = next(f for f in report.findings if f.check == "genesis")
    assert finding.level == "FAIL"
    assert "final_app_head" in finding.detail
    assert not report.ok


# --- merkle parity ------------------------------------------------------------


def test_merkle_known_answer_and_exhaustive_inclusion() -> None:
    # Same RFC 6962 known-answer vector as the TypeScript suite.
    assert merkle_root([b""]).hex() == (
        "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d"
    )
    for n in range(1, 17):
        leaves = [canonical({"log": i, "n": n}).encode() for i in range(n)]
        root = merkle_root(leaves)
        for i in range(n):
            proof = inclusion_proof(i, leaves)
            assert verify_inclusion(leaves[i], i, n, proof, root)
            assert not verify_inclusion(b"tampered", i, n, proof, root)
        assert len(inclusion_proof(0, leaves)) <= 4  # log2(16)
    assert leaf_hash(b"x") == hashlib.sha256(b"\x00x").digest()


# --- topic verification ---------------------------------------------------------


def test_clean_topic_passes_all_checks() -> None:
    report = verify_topic("0.0.9218174", make_topic(["ode-2", "ode-2", "ode-2b"]))
    levels = {f.check: f.level for f in report.findings}
    assert levels["running-hash"] == "PASS"
    assert levels["app-chain"] == "PASS"
    assert report.ok


def test_forged_record_breaks_both_layers() -> None:
    messages = make_topic(["ode-2", "ode-2", "ode-2"])
    # Replace message 2's bytes after sealing — running hash AND app chain break.
    forged = _record_bytes("ode-2", GENESIS_PREV, 99)
    m = messages[1]
    messages[1] = TopicMessage(
        topic_id=m.topic_id, payer_id=m.payer_id, seconds=m.seconds, nanos=m.nanos,
        sequence_number=m.sequence_number, message=forged,
        running_hash=m.running_hash, running_hash_version=3,
    )
    report = verify_topic("0.0.9218174", messages)
    levels = {f.check: f.level for f in report.findings}
    assert levels["running-hash"] == "FAIL"
    assert levels["app-chain"] == "WARN"  # consensus order authoritative (D11)
    assert not report.ok


def test_partial_dump_skips_genesis_but_checks_links() -> None:
    messages = make_topic(["ode-2", "ode-2", "ode-2"])[1:]  # starts at seq 2
    report = verify_topic("0.0.9218174", messages)
    app = next(f for f in report.findings if f.check == "app-chain")
    assert app.level == "PASS"
    assert "partial dump" in app.detail


# --- manifests + commitments -----------------------------------------------------


def test_batch_manifest_roundtrip_and_tamper() -> None:
    messages = make_topic(["ode-2b"])
    report = verify_topic("0.0.9218174", messages)
    logs = [{"call": i} for i in range(3)]
    manifest = {"kind": "batch", "batchId": "batch-1", "logs": logs}
    verify_batch_manifest(report, manifest)
    assert any(f.level == "PASS" and f.check == "batch:batch-1" for f in report.findings)

    tampered = {"kind": "batch", "batchId": "batch-1", "logs": [{"call": 0}, {"call": 1}, {"call": 9}]}
    verify_batch_manifest(report, tampered)
    assert any(f.level == "FAIL" and f.check == "batch:batch-1" for f in report.findings)


def test_commitment_verification_pass_and_fail() -> None:
    report = verify_topic("0.0.9218174", make_topic(["ode-2"]))
    event_id = "00000000-0000-4000-8000-000000000001"
    payload = {
        "event_salt": _SALT.hex(),
        "inputs": {"n": 1},
        "output": {"decision": "advance"},
        "context": None,
        "actions": None,
        "trace": None,
    }
    verify_commitments(report, event_id, payload)
    assert any(f.level == "PASS" and f.check == f"commit:{event_id}" for f in report.findings)

    lied = dict(payload, output={"decision": "reject"})
    verify_commitments(report, event_id, lied)
    assert any(
        f.level == "FAIL" and "output" in f.detail for f in report.findings if f.check == f"commit:{event_id}"
    )


# --- cross-mirror ----------------------------------------------------------------


def test_cross_check_agreement_and_divergence() -> None:
    a = make_topic(["ode-2", "ode-2", "ode-2b"])
    assert cross_check(a, a[:2]).agree  # different tails are fine
    b = list(a)
    m = b[1]
    b[1] = TopicMessage(
        topic_id=m.topic_id, payer_id=m.payer_id, seconds=m.seconds, nanos=m.nanos + 1,
        sequence_number=m.sequence_number, message=m.message,
        running_hash=m.running_hash, running_hash_version=3,
    )
    result = cross_check(a, b)
    assert not result.agree
    assert "timestamp differs at seq 2" in result.detail


def test_real_dump_shape_loads() -> None:
    # The archive format equals the mirror REST row shape.
    raw = {
        "consensus_timestamp": "1781300000.000000001",
        "topic_id": "0.0.9218174",
        "payer_account_id": "0.0.9185779",
        "sequence_number": 1,
        "message": base64.b64encode(_record_bytes("ode-2", GENESIS_PREV, 1)).decode(),
        "running_hash": base64.b64encode(bytes(48)).decode(),
        "running_hash_version": 3,
    }
    msg = TopicMessage.from_mirror(raw)
    assert json.loads(msg.message)["v"] == "ode-2"
