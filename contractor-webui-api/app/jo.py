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

# Per-contractor notification drop directory. Any file dropped at
# <dir>/<slug>/*.md is consumed on the next Jo session-open and prepended
# to the first-turn directive. Lets a Mayor (or an inbox watcher) fan
# messages out to a contractor even when Jo isn't live; they get them on
# next login. Files are deleted after consumption.
JO_NOTIFICATIONS_DIR = os.environ.get(
    "JO_NOTIFICATIONS_DIR",
    "/srv/town/shared/canonical-jo/notifications",
)

# Per-contractor-per-user persistence of claude's conversation id. When a
# contractor opens Jo again (after SPA reload, after logout, after FastAPI
# restart), we reuse the prior claude --session-id so claude itself picks up
# the conversation history via --resume on the next message. The mirror file
# is FastAPI-owned; UI history doesn't land here (claude's session file
# lives under sales-agent's home and is strict-confidence per the pin — the
# FastAPI does NOT read the transcript body, only persists the pointer).
JO_PERSIST_DIR = os.environ.get(
    "JO_PERSIST_DIR",
    os.path.expanduser("~/.cache/contractor-webui-api/jo-conversations"),
)
# Spawn cwd for claude. Claude has a silent-suppress-output failure mode when
# launched from a directory containing a .claude/ workspace trust entry in an
# unexpected state (e.g. %h/contractor-webui-api inherits jjoyner's config into
# a subprocess running as sales-agent, and claude bails with no stdout).
# Setting this to a neutral dir the target user owns avoids that trap.
JO_SPAWN_CWD = os.environ.get("JO_SPAWN_CWD", "/tmp")

# Path to the canonical Jo persona. When set + readable, its contents are
# passed via --system-prompt to every claude invocation so Jo boots with
# his canonical voice (per project_canonical_jo). We point at persona.md
# rather than system-prompt.md — the latter contains a "session-start
# sequence" that instructs Jo to read relative-path files (persona.md,
# memory-manifest.yaml, overlay/contractor-context.md) which don't exist
# in JO_SPAWN_CWD=/tmp, causing Jo to hang for 60s+ on failed Read tool
# calls. persona.md is pure voice/identity; no file-reading directives.
JO_SYSTEM_PROMPT_PATH = os.environ.get(
    "JO_SYSTEM_PROMPT_PATH",
    "/srv/town/shared/canonical-jo/current/persona.md",
)

_cached_system_prompt: str | None = None


def _plaza_addendum() -> str:
    """Appended to the persona so Jo knows the absolute Plaza publish path.

    Fresh-spawn Jo subprocesses were writing hails to /tmp/publish/ (a
    relative "publish/" path off cwd=/tmp) because nothing in persona.md told
    them the absolute path. system-prompt.md mentions Plaza generically but
    says "the path your Mayor has configured" — which had no configured value
    for web-UI Jo. Explicit path per-contractor fixes it.

    Resolves from cfg.publish_box rather than cfg.slug so staging envs
    (slug=pasha-staging) write to the SHARED /srv/town/shared/publish/pasha/
    dir — John sees staging hails alongside prod hails without persona drift.
    """
    publish_dir = "/srv/town/shared/publish/pasha"
    try:
        from .config import load_config as _load_config
        cfg = _load_config()
        publish_dir = str(cfg.publish_box)
    except Exception:  # noqa: BLE001
        pass
    return (
        "\n\n## Plaza publishing — explicit path\n\n"
        "When you publish a hail (e.g., to your Mayor, to another silo), write "
        f"the file as an ABSOLUTE PATH under `{publish_dir}/`. Use the "
        "Write tool with a path like:\n\n"
        f"  {publish_dir}/YYYYMMDD-HHMMSS-from-jo-<kebab-subject>.md\n\n"
        "Never write to `/tmp/publish/` or any relative `publish/` path — "
        "those don't reach Plaza. Your working directory is `/tmp` (a neutral "
        "spawn dir); it is NOT the Plaza root. The absolute path above IS the "
        "Plaza root for your silo; you have write access via the town-crew "
        "group. Filename conventions:\n"
        "- Prefix `YYYYMMDD-HHMMSS-from-jo-` (ISO-8601 local date, no colons)\n"
        "- Kebab-case subject suffix\n"
        "- Body starts with `To: <mayor-or-silo-name>` header line + blank line\n"
        "- Sign `— Jo` at the bottom\n"
    )


def _load_system_prompt() -> str | None:
    global _cached_system_prompt
    if _cached_system_prompt is not None:
        return _cached_system_prompt or None
    try:
        from pathlib import Path as _Path
        p = _Path(JO_SYSTEM_PROMPT_PATH)
        if not p.is_file():
            _cached_system_prompt = ""
            return None
        txt = p.read_text(encoding="utf-8", errors="replace").strip()
        # Append Plaza-path addendum so Jo publishes hails to the absolute
        # canonical path (not /tmp/publish/). See _plaza_addendum() docstring.
        txt = txt + _plaza_addendum()
        _cached_system_prompt = txt
        log.info("jo.system_prompt.loaded path=%s bytes=%d", p, len(txt))
        return txt or None
    except Exception as err:  # noqa: BLE001
        log.warning("jo.system_prompt.skip err=%s", err)
        _cached_system_prompt = ""
        return None


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
            # Tick at 5s so we can pick up new notification files and live-
            # inject them into any active Jo session within a few seconds.
            # Idle reap needs coarser cadence; every 12th tick = 60s.
            tick = 0
            while True:
                await asyncio.sleep(5)
                tick += 1
                await self._poll_notifications_live_inject()
                if tick % 12 == 0:
                    await self._reap_idle()
        except asyncio.CancelledError:
            return

    async def _poll_notifications_live_inject(self) -> None:
        """If this contractor has a live Jo session AND there are pending
        notifications in the slug's drop dir, deliver them to the live
        session as a Jo-voice digest + consume the files.

        Cross-instance path: Jake-on-jake-dash POSTs /jo/ping {to:"pasha"} →
        file drops in pasha's dir → pasha's FastAPI sees it here within 5s →
        if Pasha has Jo open right now, Jo delivers it in the active stream.
        """
        try:
            live = [s for s in self._sessions.values() if not s.closed]
            if not live:
                return
            from pathlib import Path as _Path
            from .config import load_config as _load_config
            cfg = _load_config()
            slug_dir = _Path(JO_NOTIFICATIONS_DIR) / cfg.slug
            if not slug_dir.is_dir():
                return
            files = sorted(slug_dir.glob("*.md"))
            if not files:
                return
            items: list[str] = []
            for p in files:
                try:
                    body = p.read_text(encoding="utf-8", errors="replace").strip()
                    if body:
                        items.append(body)
                    p.unlink(missing_ok=True)
                except Exception as e:  # noqa: BLE001
                    log.warning("jo.live_inject.skip path=%s err=%s", p, e)
            if not items:
                return
            bullets = "\n\n".join(f"- {it}" for it in items)
            directive = (
                "[OPERATOR DIRECTIVE — new in-session notifications for your contractor]\n"
                "Deliver the following items as a quick heads-up right now, in your "
                "voice. Keep it brief; don't lecture. Then return control to the "
                "contractor for whatever they were doing.\n\n"
                "---BEGIN NOTIFICATIONS---\n"
                + bullets +
                "\n---END NOTIFICATIONS---"
            )
            # Most recent session per user wins (users typically have 1).
            by_user: dict[str, JoSession] = {}
            for s in live:
                prev = by_user.get(s.user_id)
                if prev is None or s.last_active_at > prev.last_active_at:
                    by_user[s.user_id] = s
            for s in by_user.values():
                log.info("jo.live_inject.dispatching session=%s items=%d", s.id, len(items))
                asyncio.create_task(self._run_claude(s, directive))
        except Exception:  # noqa: BLE001
            log.exception("jo.live_inject.loop_error")

    async def _reap_idle(self) -> None:
        now = time.time()
        to_kill = [s for s in self._sessions.values() if now - s.last_active_at > JO_IDLE_TTL_SECONDS]
        for s in to_kill:
            await self._close_session(s, reason="idle_ttl")

    def _user_sessions(self, user_id: str) -> list[JoSession]:
        return [s for s in self._sessions.values() if s.user_id == user_id and not s.closed]

    def _persist_path(self, user_id: str) -> "Path":  # type: ignore[name-defined]
        from pathlib import Path as _Path
        # user_id is a UUID from the JWT — safe to put in a path; sanitize
        # defensively anyway.
        safe = "".join(c for c in user_id if c.isalnum() or c in "-_")[:128]
        return _Path(JO_PERSIST_DIR) / f"{safe}.txt"

    def _read_persisted_claude_id(self, user_id: str) -> tuple[str | None, bool]:
        p = self._persist_path(user_id)
        try:
            if not p.is_file():
                return None, False
            v = p.read_text(encoding="utf-8").strip()
            if not v:
                return None, False
            # Basic UUID shape check — avoid feeding garbage into claude
            # --resume and burning a real claude call to discover it.
            try:
                uuid.UUID(v)
            except ValueError:
                log.warning("jo.persist.corrupt path=%s", p)
                return None, False
            return v, True
        except Exception as e:  # noqa: BLE001
            log.warning("jo.persist.read_failed err=%s", e)
            return None, False

    def _write_persisted_claude_id(self, user_id: str, claude_sid: str) -> None:
        p = self._persist_path(user_id)
        try:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(claude_sid + "\n", encoding="utf-8")
        except Exception as e:  # noqa: BLE001
            log.warning("jo.persist.write_failed err=%s", e)

    def reset_conversation(self, user_id: str) -> None:
        """Clear the persisted claude conversation id for this user.

        Next session-open mints a fresh UUID; claude starts over with no
        prior context. Use when the contractor wants a "new conversation."
        Does NOT affect the current in-memory session; callers should
        close() that separately if desired.
        """
        p = self._persist_path(user_id)
        try:
            p.unlink(missing_ok=True)
            log.info("jo.persist.reset user=%s", user_id)
        except Exception as e:  # noqa: BLE001
            log.warning("jo.persist.reset_failed err=%s", e)

    def create_session(self, user_id: str) -> JoSession:
        if not JO_SPAWN_SUDO_USER and shutil.which(JO_CLAUDE_BIN) is None:
            raise JoClaudeMissing(f"claude binary not found (JO_CLAUDE_BIN={JO_CLAUDE_BIN})")
        existing = self._user_sessions(user_id)
        if len(existing) >= JO_MAX_SESSIONS_PER_USER:
            raise JoSessionLimitExceeded(f"max {JO_MAX_SESSIONS_PER_USER} concurrent sessions per user")

        # Resume the persisted claude conversation if one exists for this user;
        # otherwise mint a new UUID and persist it so future opens resume here.
        persisted_id, resuming = self._read_persisted_claude_id(user_id)
        claude_sid = persisted_id or str(uuid.uuid4())
        sess = JoSession(
            id=str(uuid.uuid4()),
            user_id=user_id,
            claude_session_id=claude_sid,
            created_at=time.time(),
            last_active_at=time.time(),
            # If resuming, the very first turn should use --resume, not
            # --session-id — claude already knows this conversation.
            first_turn_done=resuming,
        )
        if not resuming:
            self._write_persisted_claude_id(user_id, claude_sid)
        self._sessions[sess.id] = sess
        log.info(
            "jo.session.create id=%s user=%s claude_sid=%s resuming=%s",
            sess.id, user_id, claude_sid, resuming,
        )

        # First-turn directive is the union of:
        #   1. Any pending notifications for this contractor (consumed + deleted)
        #   2. The Mayor-staged pending-first-turn.md, if present
        #   3. If resuming a prior conversation, a silent recap directive
        #      (so the UI shows continuity — claude has the transcript, the
        #      browser does not).
        # If any piece is non-empty, spawn claude immediately so the contractor
        # sees a welcome response before typing anything.
        parts: list[str] = []
        notif_block = self._drain_notifications()
        if notif_block:
            parts.append(notif_block)
        first_turn = self._load_first_turn()
        if first_turn:
            parts.append(first_turn)
        if resuming and not parts:
            # Resume-only: no notifications, no staged welcome → emit a compact
            # recap of the last turns so the UI shows the thread picks up
            # cleanly. Keep it short; contractor doesn't want a novel.
            parts.append(
                "[OPERATOR DIRECTIVE — session resumed from prior conversation]\n"
                "The contractor just reopened Jo. Your previous conversation "
                "history is loaded. Emit a compact 2-3 line recap of what we "
                "were last discussing in your voice, then wait for the "
                "contractor's next message. Do not repeat the whole thread — "
                "just enough to re-anchor. Example register: \"Picking up where "
                "we left off — you were asking about <X>, I had offered <Y>. "
                "What's next?\""
            )
        if parts:
            directive = "\n\n---\n\n".join(parts)
            asyncio.create_task(self._run_claude(sess, directive))

        return sess

    def _drain_notifications(self) -> str | None:
        """Consume + delete all notification files for this contractor.

        Each file becomes one bullet in an operator directive Jo should deliver
        in his voice on session-open. Format inside each file is free-form;
        the filename timestamp (sortable) defines delivery order.
        """
        try:
            from pathlib import Path as _Path
            from .config import load_config as _load_config
            cfg = _load_config()
            slug_dir = _Path(JO_NOTIFICATIONS_DIR) / cfg.slug
            if not slug_dir.is_dir():
                return None
            files = sorted(slug_dir.glob("*.md"))
            if not files:
                return None
            items: list[str] = []
            for p in files:
                try:
                    body = p.read_text(encoding="utf-8", errors="replace").strip()
                    if body:
                        items.append(body)
                    p.unlink(missing_ok=True)
                except Exception as e:  # noqa: BLE001
                    log.warning("jo.notifications.skip path=%s err=%s", p, e)
            if not items:
                return None
            log.info("jo.notifications.drained slug=%s count=%d", cfg.slug, len(items))
            bullets = "\n\n".join(f"- {it}" for it in items)
            return (
                "[OPERATOR DIRECTIVE — pending notifications for your contractor]\n"
                "Deliver the following items as your first response on this "
                "session, in your voice. Frame them as a quick heads-up digest.\n\n"
                "---BEGIN NOTIFICATIONS---\n"
                + bullets +
                "\n---END NOTIFICATIONS---"
            )
        except Exception as err:  # noqa: BLE001
            log.warning("jo.notifications.load_failed err=%s", err)
            return None

    def pending_notifications_count(self) -> int:
        """Count pending notification files for the current contractor."""
        try:
            from pathlib import Path as _Path
            from .config import load_config as _load_config
            cfg = _load_config()
            slug_dir = _Path(JO_NOTIFICATIONS_DIR) / cfg.slug
            if not slug_dir.is_dir():
                return 0
            return sum(1 for _ in slug_dir.glob("*.md"))
        except Exception:  # noqa: BLE001
            return 0

    def write_notification(self, target_slug: str, text: str, *, source: str) -> str:
        """Drop a notification file for a given contractor slug. Returns path."""
        from pathlib import Path as _Path
        slug_dir = _Path(JO_NOTIFICATIONS_DIR) / target_slug
        slug_dir.mkdir(parents=True, exist_ok=True)
        ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
        fname = f"{ts}-{uuid.uuid4().hex[:8]}.md"
        p = slug_dir / fname
        body = f"*from {source} at {ts}*\n\n{text.strip()}\n"
        p.write_text(body, encoding="utf-8")
        log.info("jo.notifications.written slug=%s path=%s bytes=%d", target_slug, p, len(body))
        return str(p)

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

        argv += ["--print"]
        system_prompt = _load_system_prompt()
        if system_prompt:
            argv += ["--system-prompt", system_prompt]
        if sess.first_turn_done:
            argv += ["--resume", sess.claude_session_id, prompt]
        else:
            argv += ["--session-id", sess.claude_session_id, prompt]
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
