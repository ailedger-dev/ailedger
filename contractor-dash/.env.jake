# Jake debug-copy build-time config. Loaded by `vite build --mode jake`.
# Public values only — inlined into the bundle. No secrets.
#
# This is a canonical copy of the contractor dashboard wired for Jake's
# end-to-end debugging. RP_ID + DASH_ORIGIN match jake-dash.ailedger.dev
# so passkeys registered here are distinct from Pasha's production portal.

VITE_CONTRACTOR_SLUG=jake
VITE_CONTRACTOR_DISPLAY_NAME=Jake (Debug)
VITE_AUTH_WORKER_URL=https://contractor-auth-jake.jakejoyner9.workers.dev
VITE_API_BASE_URL=/api
VITE_RP_ID=jake-dash.ailedger.dev
VITE_DASH_ORIGIN=https://jake-dash.ailedger.dev
