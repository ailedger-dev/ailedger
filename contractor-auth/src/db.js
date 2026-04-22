// Thin D1 helpers. No ORM. Callers build prepared statements.
//
// All timestamps are UNIX epoch seconds.

export const now = () => Math.floor(Date.now() / 1000);

export function uuid() {
  // crypto.randomUUID is available in workerd.
  return crypto.randomUUID();
}

export async function getUserByEmail(db, email) {
  return db
    .prepare("SELECT * FROM users WHERE email = ?")
    .bind(email.toLowerCase().trim())
    .first();
}

export async function getUserById(db, id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
}

export async function createUser(db, { email, displayName }) {
  const id = uuid();
  await db
    .prepare(
      "INSERT INTO users (id, email, display_name, created_at, email_verified) VALUES (?, ?, ?, ?, 0)",
    )
    .bind(id, email.toLowerCase().trim(), displayName ?? null, now())
    .run();
  return id;
}

export async function markEmailVerified(db, userId) {
  await db
    .prepare("UPDATE users SET email_verified = 1, last_login_at = ? WHERE id = ?")
    .bind(now(), userId)
    .run();
}

export async function recordLogin(db, userId) {
  await db
    .prepare("UPDATE users SET last_login_at = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?")
    .bind(now(), userId)
    .run();
}

// Account lockout: increment on failure, lock for 15 minutes after 5 consecutive failures.
export async function recordFailedAttempt(db, userId) {
  const LOCK_AFTER = 5;
  const LOCK_SECONDS = 15 * 60;
  const row = await db
    .prepare("SELECT failed_attempts FROM users WHERE id = ?")
    .bind(userId)
    .first();
  const attempts = (row?.failed_attempts ?? 0) + 1;
  const lockedUntil = attempts >= LOCK_AFTER ? now() + LOCK_SECONDS : null;
  await db
    .prepare("UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?")
    .bind(attempts, lockedUntil, userId)
    .run();
  return { attempts, lockedUntil };
}

export async function isLockedOut(db, userId) {
  const row = await db
    .prepare("SELECT locked_until FROM users WHERE id = ?")
    .bind(userId)
    .first();
  return row?.locked_until && row.locked_until > now();
}

export async function listPasskeysForUser(db, userId) {
  const res = await db
    .prepare("SELECT * FROM passkeys WHERE user_id = ?")
    .bind(userId)
    .all();
  return res.results ?? [];
}

export async function insertPasskey(db, row) {
  await db
    .prepare(
      `INSERT INTO passkeys (credential_id, user_id, public_key, counter, transports, device_label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.credentialId,
      row.userId,
      row.publicKey,
      row.counter ?? 0,
      row.transports ? JSON.stringify(row.transports) : null,
      row.deviceLabel ?? null,
      now(),
    )
    .run();
}

export async function updatePasskeyCounter(db, credentialId, counter) {
  await db
    .prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE credential_id = ?")
    .bind(counter, now(), credentialId)
    .run();
}

export async function getPasskey(db, credentialId) {
  return db
    .prepare("SELECT * FROM passkeys WHERE credential_id = ?")
    .bind(credentialId)
    .first();
}

export async function insertMagicLink(db, { userId, tokenHash, ttlSeconds, ip }) {
  const id = uuid();
  const expiresAt = now() + ttlSeconds;
  await db
    .prepare(
      `INSERT INTO magic_links (id, user_id, token_hash, expires_at, requested_ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, userId, tokenHash, expiresAt, ip ?? null, now())
    .run();
  return { id, expiresAt };
}

export async function consumeMagicLink(db, tokenHash) {
  const row = await db
    .prepare("SELECT * FROM magic_links WHERE token_hash = ?")
    .bind(tokenHash)
    .first();
  if (!row) return null;
  if (row.consumed_at) return null;
  if (row.expires_at < now()) return null;
  await db
    .prepare("UPDATE magic_links SET consumed_at = ? WHERE id = ?")
    .bind(now(), row.id)
    .run();
  return row;
}

export async function insertSession(db, { userId, refreshHash, ttlSeconds, ip, userAgent }) {
  const id = uuid();
  const expiresAt = now() + ttlSeconds;
  await db
    .prepare(
      `INSERT INTO sessions (id, user_id, refresh_hash, issued_at, expires_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, userId, refreshHash, now(), expiresAt, ip ?? null, userAgent ?? null)
    .run();
  return { id, expiresAt };
}

export async function rotateSession(db, oldId, newRefreshHash, ttlSeconds) {
  const expiresAt = now() + ttlSeconds;
  await db.batch([
    db.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ?").bind(now(), oldId),
  ]);
  const id = uuid();
  const row = await db
    .prepare("SELECT user_id, ip, user_agent FROM sessions WHERE id = ?")
    .bind(oldId)
    .first();
  if (!row) return null;
  await db
    .prepare(
      `INSERT INTO sessions (id, user_id, refresh_hash, issued_at, expires_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, row.user_id, newRefreshHash, now(), expiresAt, row.ip, row.user_agent)
    .run();
  return { id, expiresAt, userId: row.user_id };
}

export async function getSessionByRefreshHash(db, refreshHash) {
  return db
    .prepare("SELECT * FROM sessions WHERE refresh_hash = ?")
    .bind(refreshHash)
    .first();
}

export async function revokeSession(db, id) {
  await db
    .prepare("UPDATE sessions SET revoked_at = ? WHERE id = ?")
    .bind(now(), id)
    .run();
}

export async function listProjectsForUser(db, userId) {
  const res = await db
    .prepare(
      `SELECT p.id, p.slug, p.name, p.return_host, pm.role
       FROM projects p
       JOIN project_members pm ON pm.project_id = p.id
       WHERE pm.user_id = ?`,
    )
    .bind(userId)
    .all();
  return res.results ?? [];
}

export async function userHasProjectRole(db, userId, projectId, allowed) {
  const row = await db
    .prepare("SELECT role FROM project_members WHERE user_id = ? AND project_id = ?")
    .bind(userId, projectId)
    .first();
  return row && allowed.includes(row.role) ? row.role : null;
}

export async function grantProjectMembership(db, { projectId, userId, role, grantedBy }) {
  await db
    .prepare(
      `INSERT INTO project_members (project_id, user_id, role, granted_by, granted_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by, granted_at = excluded.granted_at`,
    )
    .bind(projectId, userId, role, grantedBy ?? null, now())
    .run();
}

export async function revokeProjectMembership(db, { projectId, userId }) {
  await db
    .prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?")
    .bind(projectId, userId)
    .run();
}

export async function getProjectBySlug(db, slug) {
  return db.prepare("SELECT * FROM projects WHERE slug = ?").bind(slug).first();
}
