// Passkey register/login via @simplewebauthn/browser, talking to the auth
// worker through the /auth/* Pages Function proxy.

import { startRegistration, startAuthentication } from "@simplewebauthn/browser";
import { AUTH_BASE } from "../config";

export type AuthResult =
  | { ok: true }
  | { ok: false; reason: string };

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${AUTH_BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

export async function registerPasskey(email: string, displayName?: string): Promise<AuthResult> {
  const opts = await postJson("/register-passkey/options", { email, displayName });
  if (!opts.ok) {
    const j = await opts.json().catch(() => ({}));
    return { ok: false, reason: (j as { error?: string }).error || `http_${opts.status}` };
  }
  const { options, userId } = (await opts.json()) as {
    options: Parameters<typeof startRegistration>[0];
    userId: string;
  };
  let attestation;
  try {
    attestation = await startRegistration(options);
  } catch (err) {
    return { ok: false, reason: (err as Error)?.message || "browser_cancel" };
  }
  const verify = await postJson("/register-passkey/verify", {
    userId,
    response: attestation,
  });
  if (!verify.ok) {
    const j = await verify.json().catch(() => ({}));
    return { ok: false, reason: (j as { error?: string }).error || `http_${verify.status}` };
  }
  return { ok: true };
}

export async function loginPasskey(email?: string): Promise<AuthResult> {
  const opts = await postJson("/login-passkey/options", email ? { email } : {});
  if (!opts.ok) {
    const j = await opts.json().catch(() => ({}));
    return { ok: false, reason: (j as { error?: string }).error || `http_${opts.status}` };
  }
  const { options, handle } = (await opts.json()) as {
    options: Parameters<typeof startAuthentication>[0];
    handle: string;
  };
  let assertion;
  try {
    assertion = await startAuthentication(options);
  } catch (err) {
    return { ok: false, reason: (err as Error)?.message || "browser_cancel" };
  }
  const verify = await postJson("/login-passkey/verify", {
    handle,
    response: assertion,
  });
  if (!verify.ok) {
    const j = await verify.json().catch(() => ({}));
    return { ok: false, reason: (j as { error?: string }).error || `http_${verify.status}` };
  }
  return { ok: true };
}
