"""Jo chat — `claude --print` subprocess per turn, streamed via SSE.

Architecture note: an earlier version of this module kept a long-lived
interactive `claude` process alive per Jo session via pexpect. Under
`sudo -u <contractor>` that approach never produced output — claude's
interactive TUI refuses to initialize when its grandparent is sudo-over-
pty. Rewritten to spawn `claude --print --session-id <uuid>` per user
message; subsequent turns use `--resume <uuid>` so the conversation
persists on disk and claude picks up prior context. Trade: ~1-2s
startup cost per turn; wins: works through the sudo boundary, simpler
lifecycle, no pty management.

Strict-confidence preservation (per feedback_pasha_jo_transcripts_strict_confidence):
  - Transcript BODIES are never logged — only session ids, timestamps,
    approximate token counts, and error codes.
  - Each claude subprocess runs under the contractor's Linux user when
    JO_SPAWN_SUDO_USER is set; its on-disk session file lives in that
    user's home and is unreadable by jjoyner.
  - A principal reading the FastAPI logs sees that a session ran, not
    what was said.
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
JO_SPAWN_SUDO_USER = os.environ.get("JO_SPAWN_SUDO_USER", "")

JO_PENDING_FIRST_TURN_DIR = os.environ.get(
    "JO_PENDING_FIRST_TURN_DIR",
    "/srv/town/shared/canonical-jo/pending-first-turns",
)
JO_PENDING_FIRST_TURN_CONSUME_ON_READ = (
    os.environ.get("JO_PENDING_FIRST_TURN_CONSUME_ON_READ", "0") == "1"
)
# Spawn cwd for claude. Claude has a silent-suppress-output failure mode when
# launched from a directory containing a .claude/ workspace trust entry in an
# unexpected state (e.g. %h/contractor-webui-api inherits jjoyner's config into
# a subprocess running as sales-agent, and claude bails with no stdout).
# Setting this to a neutral dir the target user owns avoids that trap.
JO_SPAWN_CWD = os.environ.get("JO_SPAWN_CWD", "/tmp")


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
    claude_session_id: str
    created_at: float
    last_active_at: float
    # True once the initial --session-id turn has run; subsequent turns
    # use --resume to pick up the persisted conversation.
    first_turn_done: bool = False
    output_queue: asyncio.Queue[str] = field(default_factory=asyncio.Queue)
    current_proc: asyncio.subprocess.Process | None = None
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
        if not JO_SPAWN_SUDO_USER and shutil.which(JO_CLAUDE_BIN) is None:
            raise JoClaudeMissing(f"claude binary not found (JO_CLAUDE_BIN={JO_CLAUDE_BIN})")
        existing = self._user_sessions(user_id)
        if len(existing) >= JO_MAX_SESSIONS_PER_USER:
            raise JoSessionLimitExceeded(f"max {JO_MAX_SESSIONS_PER_USER} concurrent sessions per user")

        sess = JoSession(
            id=str(uuid.uuid4()),
            user_id=user_id,
            claude_session_id=str(uuid.uuid4()),
            created_at=time.time(),
            last_active_at=time.time(),
        )
        self._sessions[sess.id] = sess
        log.info("jo.session.create id=%s user=%s", sess.id, user_id)

        # If a pending first-turn file exists for this contractor, schedule
        # its injection as Jo's first streamed response. The file is read
        # once, consumed (or not, per JO_PENDING_FIRST_TURN_CONSUME_ON_READ),
        # and fed to claude as the first --session-id prompt.
        directive = self._load_first_turn()
        if directive:
            asyncio.create_task(self._run_claude(sess, directive))

        return sess

    def _load_first_turn(self) -> str | None:
        try:
            from pathlib import Path as _Path
            from .config import load_config as _load_config
            cfg = _load_config()
            ft_path = _Path(JO_PENDING_FIRST_TURN_DIR) / f"{cfg.slug}.md"
            if not ft_path.is_file():
                return None
            content = ft_path.read_text(encoding="utf-8", errors="replace").strip()
            if not content:
                return None
            log.info("jo.first_turn.injecting path=%s bytes=%d", ft_path, len(content))
            directive = (
                "[OPERATOR DIRECTIVE — Mayor-approved session-open welcome]\n"
                "Deliver the following content as your very first response to the "
                "contractor, in your voice, before any user input arrives. Do not "
                "preface or summarize — emit the content as-is, then wait for the "
                "contractor's reply.\n\n"
                "---BEGIN WELCOME CONTENT---\n" + content + "\n---END WELCOME CONTENT---"
            )
            if JO_PENDING_FIRST_TURN_CONSUME_ON_READ:
                ft_path.unlink(missing_ok=True)
                log.info("jo.first_turn.consumed path=%s", ft_path)
            return directive
        except Exception as err:  # noqa: BLE001
            log.warning("jo.first_turn.skip err=%s", err)
            return None

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
        log.info("jo.session.send id=%s user=%s bytes=%d", session_id, user_id, len(text))
        # Fire-and-forget: the /send handler returns immediately; the SSE
        # stream (subscribed separately) drains the output queue.
        asyncio.create_task(self._run_claude(sess, text))

    async def _run_claude(self, sess: JoSession, prompt: str) -> None:
        """Spawn `claude --print` for one turn and pipe stdout to the queue."""
        if JO_SPAWN_SUDO_USER:
            argv = ["/usr/bin/sudo", "-n", "-u", JO_SPAWN_SUDO_USER, JO_CLAUDE_BIN]
        else:
            argv = [JO_CLAUDE_BIN]

        if sess.first_turn_done:
            argv += ["--print", "--resume", sess.claude_session_id, prompt]
        else:
            argv += ["--print", "--session-id", sess.claude_session_id, prompt]
            sess.first_turn_done = True

        try:
            proc = await asyncio.create_subprocess_exec(
                *argv,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=JO_SPAWN_CWD,
            )
        except Exception:
            log.exception("jo.session.spawn.fail id=%s", sess.id)
            await sess.output_queue.put("[error: claude spawn failed]\n")
            await sess.output_queue.put("__TURN_END__")
            return

        sess.current_proc = proc
        assert proc.stdout is not None

        while True:
            chunk_bytes = await proc.stdout.read(4096)
            if not chunk_bytes:
                break
            chunk = chunk_bytes.decode("utf-8", errors="replace")
            sess.approximate_token_count += max(1, len(chunk) // 4)
            await sess.output_queue.put(chunk)

        rc = await proc.wait()
        sess.current_proc = None
        if rc != 0 and proc.stderr is not None:
            try:
                err = (await proc.stderr.read()).decode("utf-8", errors="replace")
                if err.strip():
                    log.warning("jo.session.turn.nonzero id=%s rc=%d stderr_bytes=%d", sess.id, rc, len(err))
                    await sess.output_queue.put(f"\n[claude exited rc={rc}]\n")
            except Exception:
                pass

        await sess.output_queue.put("__TURN_END__")

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
            if chunk == "__TURN_END__":
                # Emit a per-turn completion marker; the SPA can use this
                # to clear its "thinking" indicator. Keep the SSE connection
                # open for the next user message in the same session.
                yield _sse_event("turn_end", "")
                continue
            yield _sse_event("chunk", chunk)
        yield _sse_event("done", "")

    async def close(self, user_id: str, session_id: str) -> None:
        sess = self.get(user_id, session_id)
        await self._close_session(sess, reason="user_close")

    async def _close_session(self, sess: JoSession, *, reason: str) -> None:
        if sess.closed and sess.id not in self._sessions:
            return
        sess.closed = True
        log.info(
            "jo.session.close id=%s user=%s reason=%s tokens_approx=%d duration_s=%.1f",
            sess.id, sess.user_id, reason, sess.approximate_token_count,
            time.time() - sess.created_at,
        )
        proc = sess.current_proc
        if proc is not None and proc.returncode is None:
            try:
                proc.terminate()
            except Exception:
                pass
        # Unblock any subscribed SSE stream so it yields a final `done`.
        await sess.output_queue.put("__EOS__")
        self._sessions.pop(sess.id, None)


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
