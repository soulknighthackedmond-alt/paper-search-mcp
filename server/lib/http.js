// HTTP layer: one place for timeouts, retries, backoff, rate limits and a
// polite User-Agent. Every source adapter goes through this.

import { config, hasEmail } from "../config.js";

export class HttpError extends Error {
  constructor(message, { status = 0, url = "", body = "", retryAfter = null } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
    this.body = typeof body === "string" ? body.slice(0, 400) : "";
    this.retryAfter = retryAfter;
  }

  /** A message an agent can act on, not a stack trace. */
  get hint() {
    if (this.status === 401 || this.status === 403) return "The API rejected the request — check the API key for this source in the bundle settings.";
    if (this.status === 404) return "Nothing found at that address.";
    if (this.status === 429) return "Rate limited by the source. Wait a moment or add the matching API key in the bundle settings.";
    if (this.status >= 500) return "The source is having trouble right now; try again or use another source.";
    if (this.status === 0) return "Network problem or timeout.";
    return "";
  }
}

export function userAgent() {
  const contact = hasEmail() ? `; mailto:${config.email}` : "";
  return `paper-search-plus/${config.version} (MCP academic search${contact})`;
}

// ---------------------------------------------------------------------------
// Per-host politeness. Public APIs publish their limits; these are the minimum
// gap between two requests to the same host, in milliseconds.
// ---------------------------------------------------------------------------
const HOST_INTERVALS = [
  [/^api\.crossref\.org$/, 120], // polite pool allows ~50 rps; stay modest
  [/^eutils\.ncbi\.nih\.gov$/, config.keys.ncbi ? 120 : 350], // 10 rps with key, 3 rps without
  [/^api\.semanticscholar\.org$/, config.keys.semanticScholar ? 1100 : 3200],
  [/^api\.openalex\.org$/, 110],
  [/^www\.ebi\.ac\.uk$/, 150],
  [/^api\.openreview\.net$/, 400],
  [/^doaj\.org$/, 400],
  [/^dblp\.org$/, 1100],
  [/^zenodo\.org$/, 350],
  [/^api\.archives-ouvertes\.fr$/, 350],
  [/^export\.arxiv\.org$/, 3200], // arXiv asks for >=3s between requests
  [/^arxiv\.org$/, 3200],
  [/^eprint\.iacr\.org$/, 1500],
  [/^api\.core\.ac\.uk$/, 1100],
  [/^api\.openaire\.eu$/, 350],
  [/^api\.unpaywall\.org$/, 250],
];

const nextAllowed = new Map();

function hostInterval(host) {
  for (const [re, ms] of HOST_INTERVALS) if (re.test(host)) return ms;
  return 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function respectRateLimit(host) {
  const gap = hostInterval(host);
  if (!gap) return;
  const now = Date.now();
  const at = nextAllowed.get(host) ?? 0;
  const wait = Math.max(0, at - now);
  nextAllowed.set(host, Math.max(now, at) + gap);
  if (wait > 0) await sleep(wait);
}

function retryDelayMs(attempt, retryAfter) {
  if (retryAfter) {
    const secs = Number.parseFloat(retryAfter);
    if (Number.isFinite(secs)) return Math.min(secs * 1000, 15_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), 15_000);
  }
  const base = 400 * 2 ** attempt;
  return Math.min(base + Math.random() * 250, 8_000);
}

/**
 * Fetch with retries. Returns the Response; throws HttpError when the request
 * cannot be completed at all.
 */
export async function request(url, options = {}) {
  const {
    method = "GET",
    headers = {},
    body,
    timeoutMs = config.requestTimeoutMs,
    retries = 2,
    signal,
    redirect = "follow",
    accept = "application/json",
  } = options;

  const parsed = new URL(url);
  const merged = {
    "user-agent": userAgent(),
    accept,
    ...(body ? { "content-type": "application/json" } : {}),
    ...headers,
  };

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    await respectRateLimit(parsed.host);
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const res = await fetch(url, { method, headers: merged, body, signal: combined, redirect });
      if (res.status === 429 || res.status >= 500) {
        lastError = new HttpError(`${method} ${url} -> HTTP ${res.status}`, {
          status: res.status,
          url,
          body: await res.text().catch(() => ""),
          retryAfter: res.headers.get("retry-after"),
        });
        if (attempt < retries) {
          await sleep(retryDelayMs(attempt, lastError.retryAfter));
          continue;
        }
        throw lastError;
      }
      return res;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const aborted = err?.name === "AbortError" || err?.name === "TimeoutError";
      lastError = new HttpError(
        aborted ? `Request to ${parsed.host} timed out after ${timeoutMs}ms` : `Network error contacting ${parsed.host}: ${err.message}`,
        { status: 0, url },
      );
      if (attempt < retries) {
        await sleep(retryDelayMs(attempt, null));
        continue;
      }
      throw lastError;
    }
  }
  throw lastError ?? new HttpError(`Request to ${url} failed`, { url });
}

async function ensureOk(res, url) {
  if (res.ok) return res;
  throw new HttpError(`${url} -> HTTP ${res.status}`, {
    status: res.status,
    url,
    body: await res.text().catch(() => ""),
    retryAfter: res.headers.get("retry-after"),
  });
}

export async function getText(url, options = {}) {
  const res = await ensureOk(await request(url, { accept: "text/html,application/xhtml+xml,application/xml,text/plain;q=0.9,*/*;q=0.5", ...options }), url);
  return res.text();
}

export async function getJson(url, options = {}) {
  const res = await ensureOk(await request(url, options), url);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(`${url} returned something that is not JSON`, { status: res.status, url, body: text });
  }
}

export async function postJson(url, payload, options = {}) {
  const res = await ensureOk(
    await request(url, { method: "POST", body: JSON.stringify(payload), ...options }),
    url,
  );
  return res.json();
}

/** Build a query string, dropping empty values. */
export function qs(params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) for (const item of v) usp.append(k, String(item));
    else usp.set(k, String(v));
  }
  return usp.toString();
}

/** Run tasks with a concurrency cap, keeping result order. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}
