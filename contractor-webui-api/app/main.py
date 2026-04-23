"""contractor-webui-api — FastAPI service for the contractor web UI.

Runs as the contractor's Linux user (e.g., sales-agent for Pasha) on the
desktop, bound to localhost. A Cloudflare Tunnel exposes the service at
api.<slug>.<domain> for the contractor-dash SPA to call.

Per-contractor: one process per contractor (different bind port + env), or
one process serving one contractor. Generalization is in the config layer;
the HTTP surface is identical across contractors.
"""

from __future__ import annotations

import logging
from typing import Any

import os

from fastapi import Body, Depends, FastAPI, HTTPException, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from markdown_it import MarkdownIt

from . import docs, inbox
from .auth import current_user, get_config
from .config import Config

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("contractor-webui-api")

_md = MarkdownIt("commonmark", {"html": False, "linkify": True, "breaks": False}).enable("table")


def create_app() -> FastAPI:
    cfg = get_config()
    app = FastAPI(
        title=f"contractor-webui-api ({cfg.slug})",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    if cfg.dash_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(cfg.dash_origins),
            allow_credentials=True,
            allow_methods=["GET", "POST", "OPTIONS"],
            allow_headers=["content-type", "x-csrf-token"],
            max_age=600,
        )
    log.info(
        "startup slug=%s publish_box=%s docs=%s activation=%s dash_origins=%s bind=%s:%d",
        cfg.slug, cfg.publish_box, cfg.docs_dir, cfg.activation_date,
        cfg.dash_origins, cfg.bind_host, cfg.bind_port,
    )
    return app


app = create_app()


@app.middleware("http")
async def _strip_transcript_bodies_from_errors(request: Request, call_next):
    """Strict-confidence: ensure we never surface message bodies in error logs.

    The route handlers handle the happy path. This middleware catches unhandled
    exceptions and returns a minimal error with a correlation token. Transcript
    bodies are never logged (see feedback_pasha_jo_transcripts_strict_confidence).
    """
    try:
        return await call_next(request)
    except HTTPException:
        raise
    except Exception:
        log.exception("unhandled error path=%s method=%s", request.url.path, request.method)
        return JSONResponse({"error": "internal"}, status_code=500)


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/me")
def me(user: dict[str, Any] = Depends(current_user), cfg: Config = Depends(get_config)):
    return {
        "sub": user.get("sub"),
        "email": user.get("email"),
        "contractor": cfg.slug,
        "exp": user.get("exp"),
    }


@app.get("/inbox")
def get_inbox(
    _user: dict[str, Any] = Depends(current_user),
    cfg: Config = Depends(get_config),
):
    items = inbox.list_inbox(cfg)
    return {
        "items": [
            {
                "id": e.id,
                "from": e.from_,
                "subject": e.subject,
                "date": e.date,
                "unread": e.unread,
                "path": e.path,
            }
            for e in items
        ],
    }


@app.get("/message/{message_id}")
def get_message(
    message_id: str,
    _user: dict[str, Any] = Depends(current_user),
    cfg: Config = Depends(get_config),
):
    try:
        path, entry = inbox.read_message(cfg, message_id)
    except FileNotFoundError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found") from e
    body = path.read_text(encoding="utf-8", errors="replace")
    html = _md.render(body)
    return {
        "id": entry.id,
        "name": entry.filename,
        "from": entry.from_,
        "subject": entry.subject,
        "date": entry.date,
        "html": html,
    }


@app.post("/read/{message_id}")
def post_read(
    message_id: str,
    _user: dict[str, Any] = Depends(current_user),
    cfg: Config = Depends(get_config),
):
    try:
        inbox.mark_read(cfg, message_id)
    except FileNotFoundError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found") from e
    return Response(status_code=204)


@app.get("/docs")
def get_docs(
    _user: dict[str, Any] = Depends(current_user),
    cfg: Config = Depends(get_config),
):
    items = docs.list_docs(cfg)
    return {
        "items": [
            {"id": e.id, "title": e.title, "path": e.path}
            for e in items
        ],
    }


@app.get("/doc/{doc_id}")
def get_doc(
    doc_id: str,
    _user: dict[str, Any] = Depends(current_user),
    cfg: Config = Depends(get_config),
):
    try:
        path, entry = docs.read_doc(cfg, doc_id)
    except FileNotFoundError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found") from e
    body = path.read_text(encoding="utf-8", errors="replace")
    html = _md.render(body)
    return {
        "id": entry.id,
        "name": entry.filename,
        "title": entry.title,
        "html": html,
    }


# ----- Jo chat (v2) -----
#
# Gated by JO_ENABLE=1 because v2 requires the `claude` CLI installed on the
# desktop. When disabled, the routes return 503 so the SPA can show a
# degraded state without crashing.

_JO_ENABLED = os.environ.get("JO_ENABLE", "0") == "1"


def _jo_require_enabled() -> None:
    if not _JO_ENABLED:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "jo_disabled")


@app.on_event("startup")
async def _startup_jo():
    if _JO_ENABLED:
        from .jo import get_manager
        await get_manager().start_gc()


@app.post("/jo/session")
async def jo_create_session(user: dict[str, Any] = Depends(current_user)):
    _jo_require_enabled()
    from .jo import JoClaudeMissing, JoSessionLimitExceeded, get_manager
    try:
        sess = get_manager().create_session(user_id=user["sub"])
    except JoClaudeMissing as e:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "claude_unavailable") from e
    except JoSessionLimitExceeded as e:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "session_limit") from e
    return {
        "id": sess.id,
        "created_at": sess.created_at,
        "last_active_at": sess.last_active_at,
        "status": "active",
    }


@app.get("/jo/sessions")
async def jo_list_sessions(user: dict[str, Any] = Depends(current_user)):
    _jo_require_enabled()
    from .jo import get_manager
    items = get_manager().list_for_user(user["sub"])
    return {
        "items": [
            {
                "id": s.id,
                "created_at": s.created_at,
                "last_active_at": s.last_active_at,
                "status": "closed" if s.closed else "active",
            }
            for s in items
        ],
    }


@app.post("/jo/session/{session_id}/send")
async def jo_send(
    session_id: str,
    body: dict[str, Any] = Body(...),
    user: dict[str, Any] = Depends(current_user),
):
    _jo_require_enabled()
    from .jo import JoSessionNotFound, get_manager
    text = body.get("text")
    if not isinstance(text, str) or not text:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "text_required")
    try:
        await get_manager().send(user["sub"], session_id, text)
    except JoSessionNotFound as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "session_not_found") from e
    return Response(status_code=204)


@app.get("/jo/session/{session_id}/stream")
async def jo_stream(session_id: str, user: dict[str, Any] = Depends(current_user)):
    _jo_require_enabled()
    from .jo import JoSessionNotFound, get_manager
    try:
        manager = get_manager()
        _ = manager.get(user["sub"], session_id)
    except JoSessionNotFound as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "session_not_found") from e

    async def _gen():
        async for evt in manager.stream(user["sub"], session_id):
            yield evt

    return StreamingResponse(
        _gen(),
        media_type="text/event-stream",
        headers={
            "cache-control": "no-cache, no-transform",
            "x-accel-buffering": "no",
            "connection": "keep-alive",
        },
    )


@app.delete("/jo/session/{session_id}")
async def jo_close(session_id: str, user: dict[str, Any] = Depends(current_user)):
    _jo_require_enabled()
    from .jo import JoSessionNotFound, get_manager
    try:
        await get_manager().close(user["sub"], session_id)
    except JoSessionNotFound as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "session_not_found") from e
    return Response(status_code=204)


@app.get("/jo/notifications/count")
async def jo_notifications_count(_user: dict[str, Any] = Depends(current_user)):
    """Number of pending Jo notifications for the current contractor.

    Drives the red dot on the chat bubble. Count decrements to zero when the
    next Jo session opens (drain happens inside create_session).
    """
    _jo_require_enabled()
    from .jo import get_manager
    return {"count": get_manager().pending_notifications_count()}


@app.post("/jo/ping")
async def jo_ping(
    payload: dict[str, Any] = Body(...),
    _user: dict[str, Any] = Depends(current_user),
):
    """Fan a short message to a contractor's Jo.

    MVP auth: any authenticated user of this FastAPI instance can ping any
    contractor slug reachable on this machine's shared Jo notifications
    directory. In the single-Mayor / single-Principal setup this is fine
    (jjoyner is the only principal). Tighten if we ever multi-tenant this
    FastAPI to arbitrary users.

    Body: { "to": "<slug>", "text": "<message>" }.

    The notification is dropped as a file under
    /srv/town/shared/canonical-jo/notifications/<slug>/ and consumed on the
    target contractor's next Jo session-open.
    """
    _jo_require_enabled()
    to = str(payload.get("to", "")).strip()
    text = str(payload.get("text", "")).strip()
    if not to or not text:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "missing to or text")
    if not to.replace("-", "").replace("_", "").isalnum():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid slug")
    from .jo import get_manager
    path = get_manager().write_notification(to, text, source=f"{_user.get('sub','?')[:8]}")
    return {"ok": True, "path": path}
