"""JCS (RFC 8785) canonical JSON serialization — pure stdlib.

Byte-parity contract: output must be identical to the `canonicalize` npm
package used by the proxy and SDK (see proxy/scripts/jcs-canary.mjs for the
2026-04-29 incident that motivates pinning this). The shared golden-vector
corpus lives at testdata/jcs-golden-vectors.json and is enforced by
tests/test_canonical.py on this side and sdk/test/jcs-vectors.spec.ts on the
TypeScript side.

The two easy-to-miss divergences this module handles explicitly:

* Object keys sort by UTF-16 code units (JavaScript string order), not by
  Unicode code point — U+10000 sorts before U+FF61.
* Numbers serialize per ECMAScript Number-to-string (shortest round-trip,
  ES exponent formatting): ``100.0`` → ``"100"``, ``1e-7`` → ``"1e-7"``,
  ``1e21`` → ``"1e+21"``.
"""

from __future__ import annotations

import math
import re
from collections.abc import Mapping, Sequence

__all__ = ["canonical", "canonical_bytes"]

_ESCAPES = {
    '"': '\\"',
    "\\": "\\\\",
    "\b": "\\b",
    "\t": "\\t",
    "\n": "\\n",
    "\f": "\\f",
    "\r": "\\r",
}

_REPR_RE = re.compile(r"^(?P<int>\d+)(?:\.(?P<frac>\d+))?(?:[eE](?P<exp>[+-]?\d+))?$")


def canonical(value: object) -> str:
    """Return the RFC 8785 canonical JSON text for *value*."""
    parts: list[str] = []
    _write(value, parts)
    return "".join(parts)


def canonical_bytes(value: object) -> bytes:
    """Canonical JSON as UTF-8 bytes (the form that gets hashed)."""
    return canonical(value).encode("utf-8")


def _write(value: object, out: list[str]) -> None:
    # bool must be checked before int (bool subclasses int).
    if value is None:
        out.append("null")
    elif isinstance(value, bool):
        out.append("true" if value else "false")
    elif isinstance(value, str):
        _write_string(value, out)
    elif isinstance(value, int):
        out.append(_format_int(value))
    elif isinstance(value, float):
        out.append(_format_float(value))
    elif isinstance(value, Mapping):
        _write_object(value, out)
    elif isinstance(value, Sequence):
        _write_array(value, out)
    else:
        raise TypeError(f"not JCS-serializable: {type(value).__name__}")


def _write_object(obj: Mapping[object, object], out: list[str]) -> None:
    for key in obj:
        if not isinstance(key, str):
            raise TypeError(f"JCS object keys must be str, got {type(key).__name__}")
    # UTF-16 code-unit order == JavaScript default string sort. surrogatepass
    # tolerates lone surrogates (json.loads can produce them from \uXXXX
    # escapes) and preserves the same ordering JS would apply.
    keys = sorted(obj, key=lambda k: k.encode("utf-16-be", "surrogatepass"))
    out.append("{")
    for i, key in enumerate(keys):
        if i:
            out.append(",")
        _write_string(key, out)
        out.append(":")
        _write(obj[key], out)
    out.append("}")


def _write_array(arr: Sequence[object], out: list[str]) -> None:
    out.append("[")
    for i, item in enumerate(arr):
        if i:
            out.append(",")
        _write(item, out)
    out.append("]")


def _write_string(s: str, out: list[str]) -> None:
    out.append('"')
    for ch in s:
        esc = _ESCAPES.get(ch)
        if esc is not None:
            out.append(esc)
        elif ord(ch) < 0x20:
            out.append(f"\\u{ord(ch):04x}")
        else:
            out.append(ch)
    out.append('"')


def _format_int(x: int) -> str:
    # ES integers print plainly below 1e21; at or above, exponent form.
    if -(10**21) < x < 10**21:
        return str(x)
    sign = "-" if x < 0 else ""
    digits = str(abs(x))
    return sign + _es_format(digits.rstrip("0") or "0", len(digits))


def _format_float(x: float) -> str:
    if math.isnan(x) or math.isinf(x):
        raise ValueError("NaN and Infinity are not JCS-serializable")
    if x == 0.0:
        return "0"  # covers -0.0, matching ES String(-0)
    sign = "-" if x < 0 else ""
    m = _REPR_RE.match(repr(abs(x)))
    if m is None:  # pragma: no cover - repr of a finite float always matches
        raise ValueError(f"unparseable float repr: {repr(x)}")
    int_part = m["int"]
    frac = m["frac"] or ""
    exp = int(m["exp"] or 0)
    raw = int_part + frac
    digits = raw.lstrip("0")
    # n: decimal-point position such that value == 0.<digits> * 10**n
    n = len(int_part) + exp - (len(raw) - len(digits))
    digits = digits.rstrip("0")
    return sign + _es_format(digits, n)


def _es_format(digits: str, n: int) -> str:
    """ECMA-262 Number::toString(10) layout for shortest digits + exponent."""
    k = len(digits)
    if k <= n <= 21:
        return digits + "0" * (n - k)
    if 0 < n <= 21:
        return digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return "0." + "0" * (-n) + digits
    e = n - 1
    mantissa = digits[0] + ("." + digits[1:] if k > 1 else "")
    return f"{mantissa}e{'+' if e >= 0 else '-'}{abs(e)}"
