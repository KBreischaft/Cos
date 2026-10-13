// Both archives return Reddit-shaped objects. Normalize them to one compact shape
// so tools can merge and dedupe results across sources.

const REDDIT = "https://www.reddit.com";

export function toIso(createdUtc) {
  const n = Number(createdUtc);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

function clip(text, max) {
  if (!text) return "";
  const t = String(text).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

const stripPrefix = (id) => (id ? String(id).replace(/^t\d_/, "") : id);

export function normalizePost(p, source, excerptLen = 400) {
  const id = stripPrefix(p.id);
  const permalink = p.permalink
    ? REDDIT + p.permalink
    : `${REDDIT}/r/${p.subreddit}/comments/${id}/`;
  const removed = ["[removed]", "[deleted]"].includes(p.selftext);
  return {
    type: "post",
    id,
    subreddit: p.subreddit,
    author: p.author,
    created: toIso(p.created_utc),
    created_utc: Number(p.created_utc) || 0,
    title: p.title || "",
    text: removed ? p.selftext : clip(p.selftext, excerptLen),
    url: p.url && !String(p.url).includes(`/comments/${id}`) ? p.url : undefined,
    score: p.score ?? null,
    num_comments: p.num_comments ?? null,
    permalink,
    source,
  };
}

export function normalizeComment(c, source, excerptLen = 600) {
  const id = stripPrefix(c.id);
  const postId = stripPrefix(c.link_id);
  const permalink = c.permalink
    ? REDDIT + c.permalink
    : `${REDDIT}/r/${c.subreddit}/comments/${postId}/_/${id}/`;
  return {
    type: "comment",
    id,
    post_id: postId,
    parent_id: c.parent_id,
    subreddit: c.subreddit,
    author: c.author,
    created: toIso(c.created_utc),
    created_utc: Number(c.created_utc) || 0,
    text: clip(c.body, excerptLen),
    score: c.score ?? null,
    permalink,
    source,
  };
}

// Arctic Shift's /comments/tree returns Reddit listing nodes:
// { kind: "t1", data: { ..., replies: { data: { children: [...] } } } }
// plus "more" stubs. Flatten to a depth-annotated list in display order.
export function flattenTree(nodes, depth = 0, out = []) {
  for (const node of nodes || []) {
    if (!node) continue;
    const kind = node.kind;
    const d = node.data ?? node;
    if (kind === "more") {
      const n = d.count ?? (d.children || []).length;
      if (n) out.push({ type: "more", depth, count: n });
      continue;
    }
    if (d.body === undefined) continue;
    out.push({ ...d, _depth: depth });
    const replies = d.replies?.data?.children ?? (Array.isArray(d.replies) ? d.replies : []);
    flattenTree(replies, depth + 1, out);
  }
  return out;
}

export function dedupe(items) {
  const seen = new Set();
  return items.filter((it) => {
    const k = `${it.type}:${it.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Parse a post id out of a bare id, t3_ id, or any reddit/redd.it URL.
export function parsePostId(input) {
  const s = String(input).trim();
  const m = s.match(/\/comments\/([a-z0-9]+)/i) || s.match(/redd\.it\/([a-z0-9]+)/i);
  if (m) return m[1].toLowerCase();
  const bare = s.replace(/^t3_/i, "");
  if (/^[a-z0-9]{4,10}$/i.test(bare)) return bare.toLowerCase();
  throw new Error(`Could not find a Reddit post id in "${input}"`);
}

// Accepts "2021-03-01", ISO datetimes, epoch seconds, or relative ("90d", "1year").
// Returns epoch seconds for PullPush; Arctic Shift accepts the raw string, but we
// send epoch seconds to both so behavior is identical.
export function toEpoch(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const s = String(value).trim();
  if (/^\d{9,10}$/.test(s)) return Number(s);
  if (/^\d{12,13}$/.test(s)) return Math.floor(Number(s) / 1000);
  const rel = s.match(/^(\d+)\s*(s|sec|min|h|hour|hours|d|day|days|w|week|weeks|m|mo|month|months|y|year|years)$/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const secs = {
      s: 1, sec: 1, min: 60, h: 3600, hour: 3600, hours: 3600,
      d: 86400, day: 86400, days: 86400, w: 604800, week: 604800, weeks: 604800,
      m: 2592000, mo: 2592000, month: 2592000, months: 2592000,
      y: 31536000, year: 31536000, years: 31536000,
    }[unit];
    return Math.floor(Date.now() / 1000) - n * secs;
  }
  const t = Date.parse(s.length === 10 ? s + "T00:00:00Z" : s);
  if (Number.isNaN(t)) throw new Error(`Unrecognized date "${value}". Use YYYY-MM-DD, ISO, epoch, or e.g. "90d".`);
  return Math.floor(t / 1000);
}
