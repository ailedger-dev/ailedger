import { useState } from "react";
import { KeyRound, Mail, Loader2 } from "lucide-react";
import { registerPasskey, loginPasskey } from "../lib/passkey";
import { config } from "../config";

interface Props {
  onLogin: () => void;
}

export default function Login({ onLogin }: Props) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<"register" | "login" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function handleRegister() {
    setErr(null);
    setBusy("register");
    const r = await registerPasskey(email.trim(), config.displayName);
    setBusy(null);
    if (!r.ok) {
      setErr(errorText(r.reason));
      return;
    }
    onLogin();
  }

  async function handleLogin() {
    setErr(null);
    setBusy("login");
    const r = await loginPasskey(email.trim() || undefined);
    setBusy(null);
    if (!r.ok) {
      setErr(errorText(r.reason));
      return;
    }
    onLogin();
  }

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl p-8">
        <h1 className="text-xl font-semibold mb-1">Sign in</h1>
        <p className="text-sm text-zinc-400 mb-6">
          {config.displayName} · <span className="text-zinc-500">{config.dashOrigin.replace(/^https?:\/\//, "")}</span>
        </p>

        <label className="block text-xs text-zinc-400 mb-2" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-md text-sm focus:outline-none focus:border-blue-500"
        />

        <button
          type="button"
          onClick={handleLogin}
          disabled={busy !== null}
          className="mt-4 w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 rounded-md text-sm font-semibold disabled:opacity-50"
        >
          {busy === "login" ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
          Sign in with passkey
        </button>

        <button
          type="button"
          onClick={handleRegister}
          disabled={busy !== null || email.trim().length === 0}
          className="mt-2 w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-transparent border border-zinc-700 hover:border-zinc-500 rounded-md text-sm disabled:opacity-50"
        >
          {busy === "register" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
          Register a passkey
        </button>

        {err && (
          <p className="mt-4 text-sm text-rose-400" role="alert">
            {err}
          </p>
        )}

        <p className="mt-6 text-xs text-zinc-500">
          Passkeys replace passwords. Your device (Touch ID / Face ID / Windows Hello) stores a
          cryptographic key scoped to {config.rpId}; it never leaves your device.
        </p>
      </div>
    </div>
  );
}

function errorText(reason: string): string {
  if (reason === "email_not_allowed") return "This email is not authorized for this contractor portal.";
  if (reason === "email_required") return "Please enter your email.";
  if (reason === "browser_cancel") return "Passkey action canceled.";
  if (reason === "verification_failed") return "Passkey verification failed.";
  if (reason === "unknown_credential") return "This passkey is not registered for this contractor.";
  if (reason === "account_locked") return "Account locked after repeated failures. Contact your principal.";
  if (reason.startsWith("http_")) return `Sign-in failed (${reason.slice(5)}).`;
  return reason;
}
