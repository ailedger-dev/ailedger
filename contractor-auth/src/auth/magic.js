// Magic-link fallback.
//
// Request flow:
//   - client POSTs {email} to /magic-link/request.
//   - worker upserts user (email_verified stays 0 until redemption).
//   - generates 32-byte random token; stores SHA-256(token) in magic_links.
//   - emails the raw token as part of a single-use URL via Gmail API (pending
//     Google Workspace provisioning; currently fails closed — see Jake universal
//     directive 2026-04-30 / memory/feedback_email_stack_google_only.md).
//   - response is ALWAYS 200 with the same body shape regardless of whether the
//     email exists. This prevents account-enumeration.
//
// Verify flow:
//   - client POSTs {token} to /magic-link/verify.
//   - worker hashes, looks up, checks expiry + consumed_at, marks consumed.
//   - returns {userId, email} for the caller to issue a session.

import { createUser, getUserByEmail, insertMagicLink, consumeMagicLink, markEmailVerified } from "../db.js";
import { randomToken, sha256Hex } from "./session.js";

export async function requestMagicLink({ env, email, ip }) {
  const normalized = email.toLowerCase().trim();
  let user = await getUserByEmail(env.DB, normalized);
  if (!user) {
    const id = await createUser(env.DB, { email: normalized });
    user = { id };
  }
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const ttl = Number(env.MAGIC_LINK_TTL_SECONDS ?? 600);
  await insertMagicLink(env.DB, {
    userId: user.id,
    tokenHash,
    ttlSeconds: ttl,
    ip,
  });
  const link = `${env.RP_ORIGIN}/magic-link/land#token=${token}`;
  await sendEmail({
    env,
    to: normalized,
    subject: "Your sign-in link",
    text: `Click to sign in (valid for ${Math.floor(ttl / 60)} minutes):\n\n${link}\n\nIf you didn't request this, ignore it.`,
    html: `<p>Click to sign in (valid for ${Math.floor(ttl / 60)} minutes):</p><p><a href="${link}">Sign in</a></p><p style="color:#888">If you didn't request this, ignore it.</p>`,
  });
  return { ok: true };
}

export async function verifyMagicLink({ env, token }) {
  if (!token || typeof token !== "string" || token.length < 16) {
    return { ok: false, reason: "invalid_token" };
  }
  const tokenHash = await sha256Hex(token);
  const row = await consumeMagicLink(env.DB, tokenHash);
  if (!row) return { ok: false, reason: "invalid_or_expired" };
  await markEmailVerified(env.DB, row.user_id);
  return { ok: true, userId: row.user_id };
}

async function sendEmail({ env, to, subject, text, html }) {
  // Resend integration removed 2026-04-30 per Jake universal directive (Google-only stack).
  // Pending: Gmail API replacement once Google Workspace is provisioned for ailedger.dev.
  // See memory/feedback_email_stack_google_only.md.
  // Fail-closed contract preserved — auth flow refuses until replacement is wired.
  console.error("magic.email.gmail_api_not_yet_wired", { to, subject });
  throw new Error("email_not_configured");
}
