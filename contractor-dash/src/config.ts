// Build-time contractor config. All values come from `VITE_*` env vars and
// are inlined into the bundle. Do not put secrets here.

export interface ContractorConfig {
  slug: string;
  displayName: string;
  pageTitle?: string;
  authWorkerUrl: string;
  apiBaseUrl: string;
  rpId: string;
  dashOrigin: string;
}

function required(name: string, value: string | undefined): string {
  if (!value || value.length === 0) {
    throw new Error(`missing build-time env var: ${name}`);
  }
  return value;
}

export const config: ContractorConfig = {
  slug: required("VITE_CONTRACTOR_SLUG", import.meta.env.VITE_CONTRACTOR_SLUG),
  displayName: required("VITE_CONTRACTOR_DISPLAY_NAME", import.meta.env.VITE_CONTRACTOR_DISPLAY_NAME),
  pageTitle: import.meta.env.VITE_CONTRACTOR_PAGE_TITLE || undefined,
  authWorkerUrl: required("VITE_AUTH_WORKER_URL", import.meta.env.VITE_AUTH_WORKER_URL),
  apiBaseUrl: required("VITE_API_BASE_URL", import.meta.env.VITE_API_BASE_URL),
  rpId: required("VITE_RP_ID", import.meta.env.VITE_RP_ID),
  dashOrigin: required("VITE_DASH_ORIGIN", import.meta.env.VITE_DASH_ORIGIN),
};

// Auth routes are served via the same-origin Pages Function proxy at /auth/*.
// The browser therefore talks to the contractor's dash domain for auth traffic,
// which keeps session cookies first-party without cross-site cookie quirks.
export const AUTH_BASE = "/auth";
