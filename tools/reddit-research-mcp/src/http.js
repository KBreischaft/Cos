// Small fetch wrapper: timeout, retry with backoff, and rate-limit handling that
// honors Arctic Shift's X-RateLimit-Reset header (seconds until the limit resets).
// Live testing showed both archives throttle with more than 429: Arctic Shift
// answers 422 under load and PullPush answers 403, and the same request succeeds
// moments later. Those are retried too; 400 and 404 are not.

const USER_AGENT =
  process.env.REDDIT_MCP_USER_AGENT || "reddit-research-mcp/0.1 (+https://github.com/kbreischaft/cos)";
const TIMEOUT_MS = Number(process.env.REDDIT_MCP_TIMEOUT_MS || 30000);
const MAX_RETRIES = Number(process.env.REDDIT_MCP_MAX_RETRIES ?? 3);
const RETRYABLE = new Set([403, 408, 422, 425, 429]);
const isRetryable = (status) => RETRYABLE.has(status) || status >= 500;
const MAX_WAIT_S = 30; // never sleep longer than this on one 429

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HttpError extends Error {
  constructor(message, { status, body, url } = {}) {
    super(message);
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

export function buildUrl(base, path, params = {}) {
  const url = new URL(path, base.endsWith("/") ? base : base + "/");
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

export async function getJson(url) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (res.ok) {
        try {
          return JSON.parse(text);
        } catch {
          throw new HttpError(`Non-JSON response from ${new URL(url).host}`, {
            status: res.status,
            body: text.slice(0, 300),
            url,
          });
        }
      }
      const detail = text.replace(/\s+/g, " ").trim().slice(0, 160);
      const err = new HttpError(`HTTP ${res.status} from ${new URL(url).host}${detail ? `: ${detail}` : ""}`, {
        status: res.status,
        body: text.slice(0, 500),
        url,
      });
      if (!isRetryable(res.status)) throw err;
      lastErr = err;
      if (attempt === MAX_RETRIES) break;
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      const waitS = Number.isFinite(reset) && reset > 0 ? Math.min(reset, MAX_WAIT_S) : 2 ** (attempt + 1);
      await sleep(waitS * 1000);
    } catch (e) {
      if (e instanceof HttpError && e.status && !isRetryable(e.status)) throw e;
      lastErr = e.name === "AbortError" ? new HttpError(`Timed out after ${TIMEOUT_MS}ms: ${url}`, { url }) : e;
      if (attempt === MAX_RETRIES) break;
      await sleep(2 ** (attempt + 1) * 1000);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}
