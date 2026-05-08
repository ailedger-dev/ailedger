# contractor-dash

Generalized contractor web UI SPA, deployed per contractor to Cloudflare Pages.
First deployment: `pasha.jvholdings.co` (for Pasha Missaghieh).

- React 19 + Vite + TypeScript + Tailwind v4 + Lucide icons.
- Passkey-first login via `@simplewebauthn/browser` → contractor-auth Worker.
- Pages Function `functions/auth/[[path]].ts` proxies `/auth/*` to the auth
  Worker so session cookies stay first-party on the contractor's dash domain.
- Client-side routes: `/`, `/login`, `/app/...`, `/logout`.
- v0: login + hello-stub + sidebar + inbox/docs UI that degrades gracefully
  when the desktop API isn't reachable.
- v1: inbox + reading-room lit up by the `contractor-webui-api` FastAPI service
  behind `api.<contractor>.jvholdings.co` (Cloudflare Tunnel).
- v2 (future): Jo chat SSE pane.

## Per-contractor configuration

Build-time config is provided via `VITE_*` env vars, loaded by Vite from
`.env.<slug>` when building with `--mode <slug>`. Public values only.

See `.env.example` for the canonical list.

Adding a contractor:

1. Create a Cloudflare Pages project named `contractor-dash-<slug>`.
2. Set the Pages project's environment variable `AUTH_WORKER_URL` to the
   contractor's deployed `contractor-auth-<slug>` worker URL. This value is
   read by the Pages Function `functions/auth/[[path]].ts` at runtime.
3. Add `.env.<slug>` at the root of this package with the `VITE_*` values.
4. `npm run build:<slug>` (or add a script to `package.json`).
5. `wrangler pages deploy ./dist --project-name contractor-dash-<slug>`.
6. In Cloudflare, add the custom domain `<slug>.<jvholdings.co|etc>` to the
   Pages project. Add the CNAME record on your DNS host.

## Pasha (first deployment)

```sh
cd contractor-dash
npm install
npm run build:pasha
# First deploy (creates the Pages project):
wrangler pages deploy ./dist --project-name contractor-dash-pasha
# Set the Pages env var AUTH_WORKER_URL in the Cloudflare dashboard to
#   https://contractor-auth-pasha.jakejoyner9.workers.dev
# then add custom domain pasha.jvholdings.co.
```

## Auth cookie story

- The contractor-auth Worker issues `session` (httpOnly) and `refresh` (httpOnly, `Path=/session`) cookies without `Domain=`, so they are scoped to whichever origin returned the response.
- The Pages Function proxies /auth/* on the contractor's dash domain, so the cookies land first-party on the dash origin. `fetch(..., { credentials: "include" })` on the same origin includes them automatically.
- CSRF is double-submit: the Worker sets a non-httpOnly `csrf` cookie; `src/lib/auth.ts` reads it and sends `x-csrf-token` on state-changing requests.

## Local development

```sh
npm install
cp .env.example .env
npm run dev
```

`npm run dev` runs Vite against the local dev server. The Pages Function
requires `wrangler pages dev ./dist` (or the Pages dev command) to exercise
the full auth flow; passkey registration is easiest to test against a deployed
preview since WebAuthn requires HTTPS.
