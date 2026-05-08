// Two-tier rate limit backed by KV.
//
//   perIp:      60 requests / 60s per IP to auth endpoints
//   perAccount: 10 login attempts / 60s per account (by user id once known, by email before)
//
// Key design: KV values store (count, windowStart). Increment is best-effort:
// KV is eventually consistent across the edge, so this is not a precise counter
// — it is a soft ceiling that catches brute force at the order of magnitude,
// not a cryptographic guarantee. Account lockout (in db.js) is the backstop.

const WINDOW = 60; // seconds
const IP_LIMIT = 60;
const ACCOUNT_LIMIT = 10;

function now() {
  return Math.floor(Date.now() / 1000);
}

async function hit(kv, key, limit) {
  const raw = await kv.get(key);
  const t = now();
  let count = 0;
  let start = t;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed.start + WINDOW > t) {
        count = parsed.count;
        start = parsed.start;
      }
    } catch {
      // corrupt → reset
    }
  }
  count += 1;
  await kv.put(key, JSON.stringify({ count, start }), {
    expirationTtl: WINDOW + 5,
  });
  return { count, limit, exceeded: count > limit, retryAfter: start + WINDOW - t };
}

export async function checkIpLimit(kv, ip) {
  if (!ip) return { exceeded: false };
  return hit(kv, `rl:ip:${ip}`, IP_LIMIT);
}

export async function checkAccountLimit(kv, accountKey) {
  // accountKey = user id if known, else normalized email
  if (!accountKey) return { exceeded: false };
  return hit(kv, `rl:acct:${accountKey}`, ACCOUNT_LIMIT);
}

export function tooManyResponse({ retryAfter }) {
  return new Response(JSON.stringify({ error: "too_many_requests" }), {
    status: 429,
    headers: {
      "content-type": "application/json",
      "retry-after": String(retryAfter ?? 60),
    },
  });
}
