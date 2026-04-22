"""Jo chat — pexpect-managed `claude` CLI sessions, streamed via SSE.

One process per session. Sessions live in-memory on the FastAPI server;
they idle-out after JO_IDLE_TTL (30 min). A session's pty is owned by the
Linux user running the FastAPI (sales-agent for Pasha) — same UID posture as
the TUI dashboard's `j` keybind, so the strict-confidence operational pin is
unchanged by this surface.

Strict-confidence preservation (per feedback_pasha_jo_transcripts_strict_confidence):
  - Transcript BODIES are never logged — only session id, timestamps,
    approximate token counts, and error codes.
  - Sessions are process-local; no cross-session sharing.
  - A principal (jjoyner) reading the FastAPI logs sees that a session ran,
    not what was said.

This module is imported lazily by main.py if JO_ENABLE=1 in the env. If
`claude` is not on PATH, session spawn raises `JoClaudeMissing`, which the
HTTP handler surfaces as 503.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import time
import uuid
from dataclasses import dataclass, field
from typing import AsyncIterator

log = logging.getLogger("contractor-webui-api.jo")

JO_IDLE_TTL_SECONDS = int(os.environ.get("JO_IDLE_TTL_SECONDS", "1800"))
JO_MAX_SESSIONS_PER_USER = int(os.environ.get("JO_MAX_SESSIONS_PER_USER", "4"))
JO_CLAUDE_BIN = os.environ.get("JO_CLAUDE_BIN", "claude")


class JoClaudeMissing(RuntimeError):
    pass


class JoSessionNotFound(RuntimeError):
    pass


class JoSessionLimitExceeded(RuntimeError):
    pass


@dataclass
class JoSession:
    id: str
    user_id: str
    created_at: float
    last_active_at: float
    child: "object"  # pexpect.spawn, typed loosely to keep pexpect optional at import time
    output_queue: asyncio.Queue[str] = field(default_factory=asyncio.Queue)
    reader_task: asyncio.Task[None] | None = None
    closed: bool = False
    approximate_token_count: int = 0

    def touch(self) -> None:
        self.last_active_at = time.time()


class JoSessionManager:
    def __init__(self) -> None:
        self._sessions: dict[str, JoSession] = {}
        self._gc_task: asyncio.Task[None] | None = None

    async def start_gc(self) -> None:
        if self._gc_task is None:
            self._gc_task = asyncio.create_task(self._gc_loop())

    async def _gc_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(60)
                await self._reap_idle()
        except asyncio.CancelledError:
            return

    async def _reap_idle(self) -> None:
        now = time.time()
        to_kill = [s for s in self._sessions.values() if now - s.last_active_at > JO_IDLE_TTL_SECONDS]
        for s in to_kill:
            await self._close_session(s, reason="idle_ttl")

    def _user_sessions(self, user_id: str) -> list[JoSession]:
        return [s for s in self._sessions.values() if s.user_id == user_id and not s.closed]

    def create_session(self, user_id: str) -> JoSession:
        try:
            import pexpect  # noqa: F401
        except ImportError as e:
            raise JoClaudeMissing("pexpect not installed") from e
        if shutil.which(JO_CLAUDE_BIN) is None:
            raise JoClaudeMissing(f"claude binary not found (JO_CLAUDE_BIN={JO_CLAUDE_BIN})")
        existing = self._user_sessions(user_id)
        if len(existing) >= JO_MAX_SESSIONS_PER_USER:
            raise JoSessionLimitExceeded(f"max {JO_MAX_SESSIONS_PER_USER} concurrent sessions per user")

        import pexpect
        child = pexpect.spawn(
            JO_CLAUDE_BIN,
            ["--print=false"],
            encoding="utf-8",
            timeout=None,
            echo=False,
            dimensions=(40, 120),
        )
        sess = JoSession(
            id=str(uuid.uuid4()),
            user_id=user_id,
            created_at=time.time(),
            last_active_at=time.time(),
            child=child,
        )
        self._sessions[sess.id] = sess
        sess.reader_task = asyncio.create_task(self._read_loop(sess))
        log.info("jo.session.create id=%s user=%s", sess.id, user_id)
        return sess

    def get(self, user_id: str, session_id: str) -> JoSession:
        sess = self._sessions.get(session_id)
        if sess is None or sess.closed or sess.user_id != user_id:
            raise JoSessionNotFound(session_id)
        return sess

    def list_for_user(self, user_id: str) -> list[JoSession]:
        return self._user_sessions(user_id)

    async def send(self, user_id: str, session_id: str, text: str) -> None:
        sess = self.get(user_id, session_id)
        sess.touch()
        # Log only metadata — never the body.
        log.info("jo.session.send id=%s user=%s bytes=%d", session_id, user_id, len(text))
        try:
            sess.child.sendline(text)  # type: ignore[attr-defined]
        except Exception:
            log.exception("jo.session.send.fail id=%s", session_id)
            await self._close_session(sess, reason="send_failed")
            raise

    async def stream(self, user_id: str, session_id: str) -> AsyncIterator[str]:
        sess = self.get(user_id, session_id)
        sess.touch()
        while not sess.closed:
            try:
                chunk = await asyncio.wait_for(sess.output_queue.get(), timeout=15.0)
            except asyncio.TimeoutError:
                yield ":keepalive\n\n"
                continue
            sess.touch()
            if chunk == "__EOS__":
                break
            # Approximate token counting (used for log metadata only, not returned
            # to the principal). Length-based proxy; resists bias from whitespace.
            sess.approximate_token_count += max(1, len(chunk) // 4)
            yield _sse_event("chunk", chunk)
        yield _sse_event("done", "")

    async def close(self, user_id: str, session_id: str) -> None:
        sess = self.get(user_id, session_id)
        await self._close_session(sess, reason="user_close")

    async def _read_loop(self, sess: JoSession) -> None:
        # Read pty output in a background task. pexpect's read_nonblocking is
        # synchronous; we run it in the default executor.
        loop = asyncio.get_running_loop()
        try:
            while not sess.closed:
                try:
                    chunk = await loop.run_in_executor(None, _read_nonblocking, sess.child)
                except _PtyEof:
                    break
                if chunk:
                    await sess.output_queue.put(chunk)
        except Exception:
            log.exception("jo.session.read_loop.error id=%s", sess.id)
        finally:
            await sess.output_queue.put("__EOS__")
            sess.closed = True

    async def _close_session(self, sess: JoSession, *, reason: str) -> None:
        if sess.closed and sess.id not in self._sessions:
            return
        sess.closed = True
        log.info(
            "jo.session.close id=%s user=%s reason=%s tokens_approx=%d duration_s=%.1f",
            sess.id, sess.user_id, reason, sess.approximate_token_count,
            time.time() - sess.created_at,
        )
        try:
            sess.child.close(force=True)  # type: ignore[attr-defined]
        except Exception:
            pass
        if sess.reader_task:
            sess.reader_task.cancel()
        self._sessions.pop(sess.id, None)


class _PtyEof(Exception):
    pass


def _read_nonblocking(child: "object") -> str:
    """Read up to 4KB from pexpect child, or raise _PtyEof at EOF."""
    import pexpect
    try:
        return child.read_nonblocking(size=4096, timeout=0.25)  # type: ignore[attr-defined]
    except pexpect.EOF as e:
        raise _PtyEof() from e
    except pexpect.TIMEOUT:
        return ""


def _sse_event(event: str, data: str) -> str:
    safe = data.replace("\r\n", "\n")
    lines = "\n".join(f"data: {line}" for line in safe.split("\n"))
    return f"event: {event}\n{lines}\n\n"


# Module-level singleton. Lazily created on first access from main.py.
manager: JoSessionManager | None = None


def get_manager() -> JoSessionManager:
    global manager
    if manager is None:
        manager = JoSessionManager()
    return manager
