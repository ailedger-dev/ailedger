-- onboard-auth schema (Cloudflare D1 / SQLite)
-- All timestamps are UNIX epoch seconds (INTEGER). All ids are UUIDv4 strings.
--
-- Identity model:
--   users         — one row per human. Email is the durable identifier.
--   passkeys      — WebAuthn credentials; 1:N per user.
--   magic_links   — short-lived one-time codes for email-based fallback login.
--   sessions      — refresh-token family (one row per refresh token issued).
--                   Session JWTs themselves are stateless and not stored here.
--
-- Authorization model:
--   projects          — downstream consumer projects (john-console, future Pasha-2, etc.).
--   project_members   — (user_id, project_id, role) triples. Role ∈ owner|admin|member.
--   A user may be a member of 0..N projects.
--
-- Observability:
--   audit_log         — append-only. Never UPDATEd or DELETEd from app code.
--                       If retention policy requires purging, do it out-of-band and log the purge itself.

PRAGMA foreign_keys = ON;

-- ============================================================================
-- users
-- ============================================================================
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  email_verified  INTEGER NOT NULL DEFAULT 0,  -- boolean
  display_name    TEXT,
  created_at      INTEGER NOT NULL,
  last_login_at   INTEGER,
  -- Locked out after too many consecutive failures. NULL when not locked.
  locked_until    INTEGER,
  failed_attempts INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ============================================================================
-- passkeys (WebAuthn credentials)
-- ============================================================================
CREATE TABLE IF NOT EXISTS passkeys (
  credential_id   TEXT PRIMARY KEY,   -- base64url, from authenticator
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key      BLOB NOT NULL,
  counter         INTEGER NOT NULL DEFAULT 0,
  transports      TEXT,                -- JSON array, e.g. ["internal","hybrid"]
  device_label    TEXT,                -- user-editable friendly label
  created_at      INTEGER NOT NULL,
  last_used_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkeys(user_id);

-- ============================================================================
-- magic_links (email fallback)
--   - code is a server-generated random 256-bit token, stored hashed.
--   - consumed_at != NULL means the link has been redeemed exactly once.
-- ============================================================================
CREATE TABLE IF NOT EXISTS magic_links (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,   -- SHA-256 hex of the raw token
  expires_at   INTEGER NOT NULL,
  consumed_at  INTEGER,
  requested_ip TEXT,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_magic_links_expiry ON magic_links(expires_at);

-- ============================================================================
-- sessions (refresh-token family)
--   - Session JWTs (15 min) are stateless and NOT stored here.
--   - Each row is one refresh token. We store the hash, not the token itself.
--   - revoked_at set → refresh will fail; logout revokes.
-- ============================================================================
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_hash    TEXT NOT NULL UNIQUE,
  issued_at       INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  last_used_at    INTEGER,
  revoked_at      INTEGER,
  user_agent      TEXT,
  ip              TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

-- ============================================================================
-- projects (downstream consumers)
-- ============================================================================
CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,     -- e.g. "john-console"
  name         TEXT NOT NULL,
  return_host  TEXT NOT NULL,            -- e.g. "sales.ailedger.dev"
  created_at   INTEGER NOT NULL
);

-- ============================================================================
-- project_members (RBAC)
--   role:
--     owner  — can grant/revoke on this project, including other admins.
--     admin  — can grant/revoke members (not owners).
--     member — can authenticate into the project; no admin rights.
-- ============================================================================
CREATE TABLE IF NOT EXISTS project_members (
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
  granted_by  TEXT REFERENCES users(id),
  granted_at  INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);

-- ============================================================================
-- audit_log (append-only)
--   Every authentication event lands here. This table is WRITE-ONLY from the
--   application. No UPDATE/DELETE paths exist in the worker code.
-- ============================================================================
CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  ts          INTEGER NOT NULL,
  event       TEXT NOT NULL,   -- e.g. 'login.passkey.ok', 'login.passkey.fail', 'magic.sent'
  user_id     TEXT,            -- may be NULL for pre-identification events
  project_id  TEXT,
  ip          TEXT,
  user_agent  TEXT,
  detail      TEXT             -- JSON blob; do NOT include secrets or tokens
);

CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_event ON audit_log(event);
