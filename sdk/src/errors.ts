// AILedger SDK error hierarchy
//
// Discrimination so callers can handle different failure shapes appropriately
// without parsing message strings. All errors carry the HTTP status and the
// AILedger proxy's structured error body when available.

export class AILedgerError extends Error {
  readonly status: number;
  readonly detail: unknown;

  constructor(message: string, status: number, detail?: unknown) {
    super(message);
    this.name = 'AILedgerError';
    this.status = status;
    this.detail = detail;
  }
}

/** 400 / 422 — request payload was invalid */
export class AILedgerValidationError extends AILedgerError {
  constructor(message: string, status: number, detail?: unknown) {
    super(message, status, detail);
    this.name = 'AILedgerValidationError';
  }
}

/** 401 — missing or invalid x-ailedger-key */
export class AILedgerAuthError extends AILedgerError {
  constructor(message: string, detail?: unknown) {
    super(message, 401, detail);
    this.name = 'AILedgerAuthError';
  }
}

/** 403 — tenant ownership check failed (future v0.2.1+) */
export class AILedgerForbiddenError extends AILedgerError {
  constructor(message: string, detail?: unknown) {
    super(message, 403, detail);
    this.name = 'AILedgerForbiddenError';
  }
}

/** 429 — usage limit or rate limit hit. Includes retry-after if proxy returned it. */
export class AILedgerRateLimitError extends AILedgerError {
  readonly retryAfterSeconds: number | null;

  constructor(message: string, retryAfterSeconds: number | null, detail?: unknown) {
    super(message, 429, detail);
    this.name = 'AILedgerRateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** 5xx — proxy or upstream Supabase error. Caller should retry with backoff. */
export class AILedgerServerError extends AILedgerError {
  constructor(message: string, status: number, detail?: unknown) {
    super(message, status, detail);
    this.name = 'AILedgerServerError';
  }
}

/** Transport-level failure (network, timeout, DNS, etc) before getting a response */
export class AILedgerTransportError extends AILedgerError {
  constructor(message: string, cause?: unknown) {
    super(message, 0, cause);
    this.name = 'AILedgerTransportError';
  }
}
