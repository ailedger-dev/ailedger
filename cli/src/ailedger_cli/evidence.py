"""Evidence verification core — the offline, keyless audit procedure.

Verifies a tenant topic end-to-end from public data alone:

  1. NETWORK INTEGRITY — recompute Hedera's SHA-384 v3 running hash over the
     message bytes (ailedger_cli.runninghash, layout empirically pinned).
     This proves order, timestamps, and content against network consensus.
  2. APP CHAIN — walk the ode-2/ode-2b prev_hash chain over the ORIGINAL
     message bytes. Per design, consensus order is authoritative: a break
     here is a WARN-grade finding, recorded with its exact sequence.
  3. BATCH PROOFS — given a batch manifest (the drainer's manifests.jsonl),
     recompute the RFC 6962 root from the ordered leaves and spot-verify
     inclusion proofs for every leaf.
  4. COMMITMENTS — given a decrypted payload (JSON with event_salt + field
     values), recompute the salted commitments and compare to the on-chain
     record. Decryption itself happens outside this module (any AES-256-GCM
     tool, or the TypeScript SDK); stdlib has no GCM, and verification
     deliberately needs no keys.

Independence levels, stated honestly (docs/adr/016): multi-mirror
cross-checking (compare bytes/timestamps across independent mirror
operators) is implemented; record-file node-signature validation — the
strongest, council-signature-rooted proof — needs requester-pays bucket
access and lands behind this same interface when that access exists.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

from ailedger_cli.canonical import canonical
from ailedger_cli.merkle import inclusion_proof, merkle_root, verify_inclusion
from ailedger_cli.runninghash import (
    RUNNING_HASH_VERSION,
    Layout,
    TopicMessage,
    detect_layout,
)

__all__ = [
    "EvidenceRecord",
    "Finding",
    "VerificationReport",
    "commit_field",
    "compute_checkpoint_root",
    "verify_batch_manifest",
    "verify_checkpoint_manifest",
    "verify_commitments",
    "verify_topic",
]

GENESIS_PREV = "0" * 64
_SALT_LEN = 32
CHECKPOINT_KIND = "chk-1"


@dataclass(frozen=True)
class EvidenceRecord:
    seq: int
    consensus_ts: str
    kind: str  # ode-2 | ode-2b | unknown
    record_hash: str
    body: dict[str, Any]
    raw: bytes


@dataclass(frozen=True)
class Finding:
    level: str  # PASS | WARN | FAIL
    check: str
    detail: str


@dataclass
class VerificationReport:
    topic_id: str
    records: list[EvidenceRecord] = field(default_factory=list)
    findings: list[Finding] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not any(f.level == "FAIL" for f in self.findings)

    @property
    def warnings(self) -> int:
        return sum(1 for f in self.findings if f.level == "WARN")

    def add(self, level: str, check: str, detail: str) -> None:
        self.findings.append(Finding(level, check, detail))


def _parse(messages: list[TopicMessage]) -> list[EvidenceRecord]:
    records: list[EvidenceRecord] = []
    for msg in sorted(messages, key=lambda m: m.sequence_number):
        try:
            body = json.loads(msg.message.decode("utf-8"))
            kind = body.get("v", "unknown") if isinstance(body, dict) else "unknown"
        except (UnicodeDecodeError, json.JSONDecodeError):
            body, kind = {}, "unknown"
        records.append(
            EvidenceRecord(
                seq=msg.sequence_number,
                consensus_ts=f"{msg.seconds}.{msg.nanos:09d}",
                kind=kind,
                record_hash=hashlib.sha256(msg.message).hexdigest(),
                body=body if isinstance(body, dict) else {},
                raw=msg.message,
            )
        )
    return records


def verify_topic(topic_id: str, messages: list[TopicMessage]) -> VerificationReport:
    """Checks 1 + 2 over a full topic dump."""
    report = VerificationReport(topic_id=topic_id)
    if not messages:
        report.add("FAIL", "presence", "no messages on topic")
        return report
    report.records = _parse(messages)

    # 1. network running hash — over ADJACENT pairs (dump may be partial),
    # plus the genesis link when the dump starts at seq 1.
    bad_version = {m.running_hash_version for m in messages} - {RUNNING_HASH_VERSION}
    if bad_version:
        report.add("FAIL", "running-hash", f"unsupported running_hash_version(s): {sorted(bad_version)}")
    else:
        results = detect_layout(sorted(messages, key=lambda m: m.sequence_number))
        full = [name for name, (m, c) in results.items() if c and m == c]
        if full == [Layout(True, True, False).name]:
            checks = results[full[0]][1]
            report.add("PASS", "running-hash", f"v3/jos/payer/nanos-i32 matches {checks}/{checks} links")
        elif len(full) == 1:
            report.add("WARN", "running-hash", f"matched unexpected layout {full[0]} — network change? record in ADR")
        else:
            report.add("FAIL", "running-hash", f"no unique layout matched ({results})")

    # 2. app prev_hash chain.
    first = report.records[0]
    prev = GENESIS_PREV if first.seq == 1 else None
    breaks: list[int] = []
    for rec in report.records:
        claimed = rec.body.get("prev_hash")
        if prev is not None and claimed != prev:
            breaks.append(rec.seq)
        prev = rec.record_hash
    if breaks:
        report.add(
            "WARN",
            "app-chain",
            f"prev_hash mismatch at seq {breaks} (consensus order remains authoritative)",
        )
    else:
        start = "genesis" if first.seq == 1 else f"seq {first.seq} (partial dump)"
        report.add("PASS", "app-chain", f"continuous from {start} over {len(report.records)} records")

    # Structural sanity per record kind.
    unknown = [r.seq for r in report.records if r.kind == "unknown"]
    if unknown:
        report.add("WARN", "schema", f"unparseable record(s) at seq {unknown}")
    return report


def verify_batch_manifest(
    report: VerificationReport,
    manifest: dict[str, Any],
) -> None:
    """Check 3 — one drainer manifest line ({batchId, merkleRoot, logs[...]})
    against the on-chain ode-2b record with the same batch_id."""
    batch_id = str(manifest.get("batchId"))
    onchain = next(
        (r for r in report.records if r.kind == "ode-2b" and r.body.get("batch_id") == batch_id),
        None,
    )
    if onchain is None:
        report.add("FAIL", f"batch:{batch_id}", "no on-chain ode-2b record with this batch_id")
        return
    logs = manifest.get("logs")
    if not isinstance(logs, list) or not logs:
        report.add("FAIL", f"batch:{batch_id}", "manifest carries no ordered leaves")
        return
    leaves = [canonical(log).encode("utf-8") for log in logs]
    root = merkle_root(leaves)
    if root.hex() != onchain.body.get("merkle_root"):
        report.add("FAIL", f"batch:{batch_id}", "recomputed root does not match the on-chain merkle_root")
        return
    if len(leaves) != onchain.body.get("leaf_count"):
        report.add("FAIL", f"batch:{batch_id}", "leaf_count mismatch")
        return
    for i, leaf in enumerate(leaves):
        proof = inclusion_proof(i, leaves)
        if not verify_inclusion(leaf, i, len(leaves), proof, root):
            report.add("FAIL", f"batch:{batch_id}", f"inclusion proof fails for leaf {i}")
            return
    report.add(
        "PASS",
        f"batch:{batch_id}",
        f"root matches; all {len(leaves)} inclusion proofs verify (seq {onchain.seq})",
    )


def _checkpoint_leaf(head: dict[str, Any]) -> bytes:
    """Mirror of sdk evidence/record.ts checkpointLeaf:
    UTF-8(JCS({running_hash, sequence_number, topic_id})), casing-normalized."""
    return canonical(
        {
            "running_hash": str(head["running_hash"]).lower(),
            "sequence_number": int(head["sequence_number"]),
            "topic_id": str(head["topic_id"]),
        }
    ).encode("utf-8")


def _topic_sort_key(topic_id: str) -> tuple[int, int, int]:
    """Numeric (shard, realm, num) order — matches checkpoint.ts sortTenantHeads."""
    a, b, c = (int(p) for p in str(topic_id).split("."))
    return (a, b, c)


def compute_checkpoint_root(heads: list[dict[str, Any]]) -> str:
    """RFC 6962 root over the per-tenant head leaves, in canonical estate order.

    Independent Python reimplementation of proxy checkpoint.ts computeTenantRoot —
    the disagreement between two implementations is what makes the on-chain root
    trustworthy. Keyless: heads come from public mirror reads.
    """
    if not heads:
        raise ValueError("no tenant heads — an empty estate has no checkpoint root")
    ordered = sorted(heads, key=lambda h: _topic_sort_key(h["topic_id"]))
    return merkle_root([_checkpoint_leaf(h) for h in ordered]).hex()


def verify_checkpoint_manifest(
    report: VerificationReport,
    manifest: dict[str, Any],
) -> None:
    """Check — recompute the tenant_root from a checkpoint manifest's heads and
    confirm it matches BOTH the manifest's claimed root and an on-chain chk-1
    record. Closes the lying-checkpoint attack: a manifest whose heads don't
    produce the sealed root FAILs, recomputed by anyone with mirror access."""
    heads = manifest.get("heads")
    claimed_root = manifest.get("tenant_root")
    if not isinstance(heads, list) or not heads:
        report.add("FAIL", "checkpoint", "manifest carries no tenant heads")
        return
    try:
        recomputed = compute_checkpoint_root(heads)
    except (KeyError, ValueError, TypeError) as exc:
        report.add("FAIL", "checkpoint", f"malformed head in manifest: {exc}")
        return
    if recomputed != claimed_root:
        report.add(
            "FAIL",
            "checkpoint",
            f"manifest tenant_root {str(claimed_root)[:16]}… disagrees with recompute {recomputed[:16]}…",
        )
        return
    onchain = next(
        (
            r
            for r in report.records
            if r.kind == CHECKPOINT_KIND and r.body.get("tenant_root") == recomputed
        ),
        None,
    )
    if onchain is None:
        report.add("FAIL", "checkpoint", f"no on-chain chk-1 record carries tenant_root {recomputed[:16]}…")
        return
    if onchain.body.get("tenant_count") != len(heads):
        report.add(
            "FAIL",
            "checkpoint",
            f"tenant_count {onchain.body.get('tenant_count')} != {len(heads)} heads in manifest",
        )
        return
    report.add(
        "PASS",
        "checkpoint",
        f"tenant_root matches on-chain chk-1 over {len(heads)} tenant head(s) (seq {onchain.seq})",
    )


def commit_field(salt: bytes, field_name: str, value: Any) -> str:
    """Mirror of sdk evidence/record.ts commitField:
    SHA-256( salt ‖ UTF-8(fieldName) ‖ 0x3A ‖ UTF-8(JCS(value)) )."""
    if len(salt) != _SALT_LEN:
        raise ValueError(f"event salt must be {_SALT_LEN} bytes")
    preimage = salt + field_name.encode("utf-8") + b":" + canonical(value).encode("utf-8")
    return hashlib.sha256(preimage).hexdigest()


def verify_commitments(
    report: VerificationReport,
    event_id: str,
    payload: dict[str, Any],
) -> None:
    """Check 4 — recompute salted commitments from a decrypted payload."""
    onchain = next(
        (r for r in report.records if r.kind == "ode-2" and r.body.get("event_id") == event_id),
        None,
    )
    if onchain is None:
        report.add("FAIL", f"commit:{event_id}", "no on-chain ode-2 record with this event_id")
        return
    salt_hex = payload.get("event_salt")
    if not isinstance(salt_hex, str):
        report.add("FAIL", f"commit:{event_id}", "payload carries no event_salt")
        return
    salt = bytes.fromhex(salt_hex)
    mismatches: list[str] = []
    for fname, commit_key in (
        ("inputs", "inputs_commit"),
        ("output", "output_commit"),
        ("context", "context_commit"),
        ("actions", "actions_commit"),
        ("trace", "trace_commit"),
    ):
        expected = onchain.body.get(commit_key)
        if fname == "trace" and expected is None:
            continue  # untraced decision
        if commit_field(salt, fname, payload.get(fname)) != expected:
            mismatches.append(fname)
    if mismatches:
        report.add("FAIL", f"commit:{event_id}", f"commitment mismatch: {mismatches}")
    else:
        report.add("PASS", f"commit:{event_id}", "all field commitments verify against the payload")
