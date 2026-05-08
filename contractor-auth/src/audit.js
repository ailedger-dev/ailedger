// Append-only audit log. No UPDATE/DELETE path exists in this module on purpose.
// See SECURITY.md §Audit.
//
// detail is JSON-serialized. Callers MUST NOT pass tokens, passwords, cookies,
// JWTs, magic-link codes, or any other credential material. Low-entropy metadata
// (event names, ip, user-agent substrings, project slugs) only.

import { now, uuid } from "./db.js";

const CREDENTIAL_KEYS = new Set([
  "token",
  "refresh",
  "refresh_token",
  "session",
  "session_token",
  "jwt",
  "password",
  "secret",
  "code",
  "magic",
  "challenge",
  "authorization",
  "cookie",
]);

function sanitize(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (CREDENTIAL_KEYS.has(k.toLowerCase())) {
      out[k] = "[redacted]";
    } else if (v && typeof v === "object") {
      out[k] = sanitize(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export async function audit(db, { event, userId, projectId, ip, userAgent, detail }) {
  const clean = detail ? sanitize(detail) : null;
  try {
    await db
      .prepare(
        `INSERT INTO audit_log (id, ts, event, user_id, project_id, ip, user_agent, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        uuid(),
        now(),
        event,
        userId ?? null,
        projectId ?? null,
        ip ?? null,
        userAgent ?? null,
        clean ? JSON.stringify(clean) : null,
      )
      .run();
  } catch (err) {
    // Audit must never break the request. Log and swallow.
    console.error("audit.write.failed", event, err?.message);
  }
}
