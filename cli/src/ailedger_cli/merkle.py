"""RFC 6962 Merkle tree verification — pure stdlib.

Python counterpart of sdk/src/evidence/merkle.ts (leaf_spec
``rfc6962-sha256/jcs-v1``): 0x00/0x01 leaf/node domain prefixes, the
unbalanced split at the largest power of two strictly less than n, and the
RFC 9162 §2.1.3.2 iterative inclusion-proof verification. Cross-pinned
against the TypeScript implementation by shared test vectors.
"""

from __future__ import annotations

import hashlib

__all__ = ["leaf_hash", "merkle_root", "inclusion_proof", "verify_inclusion"]

_LEAF = b"\x00"
_NODE = b"\x01"


def leaf_hash(leaf: bytes) -> bytes:
    return hashlib.sha256(_LEAF + leaf).digest()


def _node_hash(left: bytes, right: bytes) -> bytes:
    return hashlib.sha256(_NODE + left + right).digest()


def _split(n: int) -> int:
    k = 1
    while k * 2 < n:
        k *= 2
    return k


def merkle_root(leaves: list[bytes]) -> bytes:
    """RFC 6962 MTH over leaf byte strings. Raises on an empty batch."""
    if not leaves:
        raise ValueError("empty batch has no root")
    if len(leaves) == 1:
        return leaf_hash(leaves[0])
    k = _split(len(leaves))
    return _node_hash(merkle_root(leaves[:k]), merkle_root(leaves[k:]))


def inclusion_proof(index: int, leaves: list[bytes]) -> list[bytes]:
    """Audit path for the leaf at *index* (leaf-adjacent sibling first)."""
    if not 0 <= index < len(leaves):
        raise ValueError(f"leaf index {index} out of range [0, {len(leaves)})")
    if len(leaves) == 1:
        return []
    k = _split(len(leaves))
    if index < k:
        path = inclusion_proof(index, leaves[:k])
        path.append(merkle_root(leaves[k:]))
    else:
        path = inclusion_proof(index - k, leaves[k:])
        path.append(merkle_root(leaves[:k]))
    return path


def verify_inclusion(
    leaf: bytes,
    index: int,
    tree_size: int,
    proof: list[bytes],
    expected_root: bytes,
) -> bool:
    """RFC 9162 §2.1.3.2 — pure function of public data."""
    if not 0 <= index < tree_size:
        return False
    fn, sn = index, tree_size - 1
    r = leaf_hash(leaf)
    for p in proof:
        if sn == 0:
            return False  # proof longer than the tree
        if fn % 2 == 1 or fn == sn:
            r = _node_hash(p, r)
            if fn % 2 == 0:
                while True:
                    fn >>= 1
                    sn >>= 1
                    if fn % 2 == 1 or fn == 0:
                        break
        else:
            r = _node_hash(r, p)
        fn >>= 1
        sn >>= 1
    return sn == 0 and r == expected_root
