// WebAuthn (passkey) register + login via @simplewebauthn/server.
//
// Flow:
//   register:
//     1) POST /register-passkey/options  — client submits email; worker creates
//        user if new, returns registration options + stashes challenge in KV.
//     2) POST /register-passkey/verify   — client posts attestation; worker
//        verifies with SimpleWebAuthn, persists credential, marks email verified.
//
//   login:
//     1) POST /login-passkey/options     — optional email; worker returns
//        authentication options (+challenge in KV).
//     2) POST /login-passkey/verify      — client posts assertion; worker verifies,
//        updates counter, issues session + refresh.
//
// Challenge KV keys are scoped per-email-or-user and expire in 5 minutes.

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";

import {
  createUser,
  getUserByEmail,
  getUserById,
  insertPasskey,
  getPasskey,
  listPasskeysForUser,
  updatePasskeyCounter,
  markEmailVerified,
} from "../db.js";

const CHALLENGE_TTL = 300;

function b64urlToBytes(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToB64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function setChallenge(kv, key, challenge, userId) {
  await kv.put(
    `chal:${key}`,
    JSON.stringify({ challenge, userId, ts: Date.now() }),
    { expirationTtl: CHALLENGE_TTL },
  );
}

async function takeChallenge(kv, key) {
  const raw = await kv.get(`chal:${key}`);
  if (!raw) return null;
  await kv.delete(`chal:${key}`);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function beginRegistration({ env, email, displayName }) {
  const normalized = email.toLowerCase().trim();
  let user = await getUserByEmail(env.DB, normalized);
  let userId;
  if (!user) {
    userId = await createUser(env.DB, { email: normalized, displayName });
  } else {
    userId = user.id;
  }
  const existing = await listPasskeysForUser(env.DB, userId);
  const options = await generateRegistrationOptions({
    rpName: env.RP_NAME,
    rpID: env.RP_ID,
    userID: new TextEncoder().encode(userId),
    userName: normalized,
    userDisplayName: displayName || normalized,
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
    excludeCredentials: existing.map((p) => ({
      id: p.credential_id,
      type: "public-key",
      transports: p.transports ? JSON.parse(p.transports) : undefined,
    })),
  });
  await setChallenge(env.AUTH_KV, `reg:${userId}`, options.challenge, userId);
  return { options, userId };
}

export async function finishRegistration({ env, userId, response, deviceLabel }) {
  const stash = await takeChallenge(env.AUTH_KV, `reg:${userId}`);
  if (!stash) return { ok: false, reason: "challenge_not_found" };
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: stash.challenge,
    expectedOrigin: env.RP_ORIGIN,
    expectedRPID: env.RP_ID,
    requireUserVerification: false,
  });
  if (!verification.verified || !verification.registrationInfo) {
    return { ok: false, reason: "verification_failed" };
  }
  const { credential } = verification.registrationInfo;
  await insertPasskey(env.DB, {
    credentialId: credential.id, // base64url string in simplewebauthn v10+
    userId,
    publicKey: credential.publicKey, // Uint8Array → stored as BLOB
    counter: credential.counter,
    transports: response.response?.transports,
    deviceLabel,
  });
  await markEmailVerified(env.DB, userId);
  return { ok: true, credentialId: credential.id };
}

export async function beginLogin({ env, email }) {
  let userId = null;
  let allowCredentials;
  if (email) {
    const user = await getUserByEmail(env.DB, email);
    if (user) {
      userId = user.id;
      const creds = await listPasskeysForUser(env.DB, user.id);
      allowCredentials = creds.map((c) => ({
        id: c.credential_id,
        type: "public-key",
        transports: c.transports ? JSON.parse(c.transports) : undefined,
      }));
    }
    // If user is unknown we still return options with no allowCredentials so
    // the response shape is stable and we don't leak user existence.
  }
  const options = await generateAuthenticationOptions({
    rpID: env.RP_ID,
    userVerification: "preferred",
    allowCredentials,
  });
  // Key by a random handle we return to the client so unknown-email flows still work.
  const handle = crypto.randomUUID();
  await setChallenge(env.AUTH_KV, `auth:${handle}`, options.challenge, userId);
  return { options, handle };
}

export async function finishLogin({ env, handle, response }) {
  const stash = await takeChallenge(env.AUTH_KV, `auth:${handle}`);
  if (!stash) return { ok: false, reason: "challenge_not_found" };
  const credentialId = response.id; // base64url
  const passkey = await getPasskey(env.DB, credentialId);
  if (!passkey) return { ok: false, reason: "unknown_credential" };
  const user = await getUserById(env.DB, passkey.user_id);
  if (!user) return { ok: false, reason: "user_missing" };
  if (user.locked_until && user.locked_until * 1000 > Date.now()) {
    return { ok: false, reason: "account_locked" };
  }
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: stash.challenge,
    expectedOrigin: env.RP_ORIGIN,
    expectedRPID: env.RP_ID,
    credential: {
      id: passkey.credential_id,
      publicKey: passkey.public_key,
      counter: passkey.counter,
    },
    requireUserVerification: false,
  });
  if (!verification.verified) return { ok: false, reason: "verification_failed" };
  await updatePasskeyCounter(env.DB, passkey.credential_id, verification.authenticationInfo.newCounter);
  return { ok: true, userId: user.id, email: user.email };
}
