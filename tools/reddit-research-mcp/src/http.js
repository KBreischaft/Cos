// Small fetch wrapper: timeout, retry with backoff, and rate-limit handling that
// honors Arctic Shift's X-RateLimit-Reset header (seconds until the limit resets).
// Live testing showed both archives throttle with more than 429: Arctic Shift
// answers 422 under load and PullPush answers 403, and the same request succeeds
// moments later. Those are retried too; 400 and 404 are not.
//
// Requests are also paced per host: one in flight at a time, with a minimum gap
// between them. Live runs with 4 parallel requests got "Timeout. Maybe slow down
// a bit" from Arctic Shift and a 429 from PullPush stating it "does not provide
// free scraping resources for agents". Pacing keeps this a polite, low-volume
// research client.

const USER_AGENT =
  process.env.REDDIT_MCP_USER_AGENT || "reddit-research-mcp/0.1 (+https://github.com/kbreischaft/cos)";
const TIMEOUT_MS = Number(process.env.REDDIT_MCP_TIMEOUT_MS || 30000);
const MAX_RETRIES = Number(process.env.REDDIT_MCP_MAX_RETRIES ?? 3);
const RETRYABLE = new Set([403, 408, 422, 425, 429]);
const isRetryable = (status) => RETRYABLE.has(status) || status >= 500;
const MAX_WAIT_S = 30; // never sleep longer than this on one 429

export class DeadlineError extends Error {}

const DEBUG = process.env.REDDIT_MCP_DEBUG === "1";
// Logs go to stderr: stdout is the MCP protocol channel.
const debug = (...a) => DEBUG && console.error("[reddit-mcp]", ...a);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIN_GAP_MS = { default: Number(process.env.REDDIT_MCP_MIN_GAP_MS ?? 1000), "api.pullpush.io": Number(process.env.REDDIT_MCP_PULLPUSH_GAP_MS ?? 3000) };
const hostQueues = new Map(); // host -> { tail: Promise, last: number }

// Hold every queued request to host until at least `ms` from now.
function cooldown(host, ms) {
  const q = hostQueues.get(host);
  if (!q) return;
  const gap = MIN_GAP_MS[host] ?? MIN_GAP_MS.default;
  q.last = Math.max(q.last, Date.now() + ms - gap);
}

// Run fn with exclusive access to host, at least MIN_GAP_MS after the previous call ended.
// If the required wait would run past `deadline`, fail now instead of waiting.
function paced(host, fn, deadline) {
  const q = hostQueues.get(host) || { tail: Promise.resolve(), last: 0 };
  hostQueues.set(host, q);
  const gap = MIN_GAP_MS[host] ?? MIN_GAP_MS.default;
  const run = q.tail.then(async () => {
    const wait = q.last + gap - Date.now();
    if (deadline !== undefined && Date.now() + Math.max(wait, 0) >= deadline) {
      throw new DeadlineError(`Time budget reached while queued for ${host}`);
    }
    if (wait > 0) await sleep(wait);
    try {
      return await fn();
    } finally {
      q.last = Date.now();
    }
  });
  q.tail = run.catch(() => {});
  return run;
}

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

// deadline (epoch ms, optional): give up rather than start or retry a request
// after this point, so a tool call never outlasts its budget.
export async function getJson(url, { deadline } = {}) {
  let lastErr;
  const late = () => deadline !== undefined && Date.now() >= deadline;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (late()) throw new DeadlineError(`Time budget reached before ${new URL(url).host} answered${lastErr ? ` (last error: ${lastErr.message})` : ""}`);
    try {
      const { res, text } = await paced(new URL(url).host, async () => {
        if (late()) throw new DeadlineError(`Time budget reached while queued for ${new URL(url).host}`);
        // Timer starts only once this request has its turn, not while queued.
        const ctrl = new AbortController();
        const ms = deadline === undefined ? TIMEOUT_MS : Math.max(250, Math.min(TIMEOUT_MS, deadline - Date.now()));
        const timer = setTimeout(() => ctrl.abort(), ms);
        const t0 = Date.now();
        try {
          const r = await fetch(url, {
            headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
            signal: ctrl.signal,
          });
          const body = await r.text();
          debug(`${r.status} ${Date.now() - t0}ms attempt=${attempt} ${url}`);
          return { res: r, text: body };
        } catch (e) {
          debug(`ERR ${e.name} ${Date.now() - t0}ms attempt=${attempt} ${url}`);
          throw e;
        } finally {
          clearTimeout(timer);
        }
      }, deadline);
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
      // Only a real 429 waits for the rate-limit window to reset. Arctic Shift's
      // 422 "Timeout" also carries X-RateLimit-Reset, but live diagnostics showed
      // a retry 2-4s later usually succeeds, so 422s get short backoff.
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      const waitS =
        res.status === 429 && Number.isFinite(reset) && reset > 0 ? Math.min(reset, MAX_WAIT_S) : 2 ** (attempt + 1);
      // Throttled: back the whole host queue off, not just this request.
      cooldown(new URL(url).host, waitS * 1000);
    } catch (e) {
      if (e instanceof DeadlineError) throw e;
      if (e instanceof HttpError && e.status && !isRetryable(e.status)) throw e;
      if (e.name === "AbortError" && late()) throw new DeadlineError(`Time budget reached while waiting on ${new URL(url).host}`);
      lastErr = e.name === "AbortError" ? new HttpError(`Timed out after ${TIMEOUT_MS}ms: ${url}`, { url }) : e;
      if (attempt === MAX_RETRIES) break;
      cooldown(new URL(url).host, 2 ** (attempt + 1) * 1000);
    }
  }
  throw lastErr;
}
