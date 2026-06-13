"""Byte-parity with the shared golden corpus (generated from the production
TypeScript `canonicalize` package). The same corpus pins the SDK and CLI —
all implementations must agree byte-for-byte or chain digests fork."""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from ailedger_detection.canonical import canonical, canonical_bytes

_CORPUS_PATH = Path(__file__).resolve().parents[2] / "testdata" / "jcs-golden-vectors.json"
_CORPUS = json.loads(_CORPUS_PATH.read_text(encoding="utf-8"))


@pytest.mark.parametrize("vector", _CORPUS["vectors"], ids=[v["name"] for v in _CORPUS["vectors"]])
def test_golden_vector_parity(vector: dict) -> None:
    assert canonical(vector["input"]) == vector["expected"]


def test_utf16_key_order_beats_codepoint_order() -> None:
    # U+10000 sorts BEFORE U+FF61 in UTF-16 code units; a code-point sort
    # gets this backwards and silently forks every digest.
    assert canonical({"｡": 1, "\U00010000": 2}) == '{"\U00010000":2,"｡":1}'


def test_es_number_edges_and_rejections() -> None:
    assert canonical(100.0) == "100"
    assert canonical(1e-7) == "1e-7"
    assert canonical(1e21) == "1e+21"
    assert canonical(-0.0) == "0"
    with pytest.raises(ValueError):
        canonical(math.nan)
    with pytest.raises(TypeError):
        canonical({1: "non-string key"})
    assert canonical_bytes({"€": 1}) == '{"€":1}'.encode()
