// Data sources. Reddit closed unauthenticated .json access in May 2026 and stops
// taking new Data API requests on 2026-10-31, so this server reads the two public
// Reddit archives instead:
//
//   Arctic Shift  https://github.com/ArthurHeitmann/arctic_shift  (primary)
//     Near-real-time archive. Post keyword search via `query`; comment keyword
//     search (`body`) needs a subreddit, author, or post scope. Full comment trees.
//   PullPush      https://pullpush.io  (fallback)
//     Pushshift successor. Global keyword search on posts AND comments, but has
//     had multi-week outages. Used when Arctic Shift can't answer.

import { buildUrl, getJson as rawGetJson } from "./http.js";
import { normalizeComment, normalizePost, flattenTree } from "./normalize.js";

const ARCTIC = process.env.ARCTIC_SHIFT_BASE_URL || "https://arctic-shift.photon-reddit.com";
const PULLPUSH = process.env.PULLPUSH_BASE_URL || "https://api.pullpush.io";

// Every source method takes an optional `deadline` (epoch ms) and passes it down.
const getJson = (url, deadline) => rawGetJson(url, { deadline });

const clampLimit = (n) => Math.max(1, Math.min(100, Number(n) || 25));
const unwrap = (json) => {
  if (json && json.error) throw new Error(`Archive error: ${json.error}`);
  return Array.isArray(json?.data) ? json.data : [];
};

// ---------- Arctic Shift ----------

export const arctic = {
  name: "arctic_shift",

  async searchPosts({ query, subreddit, author, after, before, limit, sort, deadline }) {
    const url = buildUrl(ARCTIC, "api/posts/search", {
      query,
      subreddit,
      author,
      after,
      before,
      limit: clampLimit(limit),
      sort: sort === "asc" ? "asc" : "desc",
    });
    return unwrap(await getJson(url, deadline)).map((p) => normalizePost(p, this.name));
  },

  async searchComments({ query, subreddit, author, postId, after, before, limit, sort, deadline }) {
    if (!subreddit && !author && !postId) {
      throw new Error("Arctic Shift comment search needs a subreddit, author, or post id");
    }
    const url = buildUrl(ARCTIC, "api/comments/search", {
      body: query,
      subreddit,
      author,
      link_id: postId,
      after,
      before,
      limit: clampLimit(limit),
      sort: sort === "asc" ? "asc" : "desc",
    });
    return unwrap(await getJson(url, deadline)).map((c) => normalizeComment(c, this.name));
  },

  async getPost(postId, deadline) {
    const url = buildUrl(ARCTIC, "api/posts/ids", { ids: postId });
    const [p] = unwrap(await getJson(url, deadline));
    return p ? normalizePost(p, this.name, 20000) : null;
  },

  async getCommentTree(postId, limit, deadline) {
    const url = buildUrl(ARCTIC, "api/comments/tree", {
      link_id: postId,
      limit: Math.max(1, Math.min(25000, Number(limit) || 500)),
      // Expand fully; the defaults (4) collapse deep threads into "more" stubs.
      start_breadth: 1000,
      start_depth: 1000,
    });
    return flattenTree(unwrap(await getJson(url, deadline))).map((c) =>
      c.type === "more" ? c : { ...normalizeComment(c, this.name, 4000), depth: c._depth }
    );
  },

  async findSubreddits({ prefix, minSubscribers, limit, deadline }) {
    const url = buildUrl(ARCTIC, "api/subreddits/search", {
      subreddit_prefix: prefix,
      min_subscribers: minSubscribers,
      limit: Math.max(1, Math.min(1000, Number(limit) || 25)),
      sort: "desc",
      sort_type: "subscribers",
    });
    return unwrap(await getJson(url, deadline)).map((s) => ({
      name: s.display_name || s.subreddit || s.name,
      subscribers: s.subscribers ?? null,
      description: (s.public_description || s.title || "").slice(0, 300),
      created: s.created_utc ? new Date(s.created_utc * 1000).toISOString().slice(0, 10) : null,
      url: `https://www.reddit.com/r/${s.display_name || s.subreddit || s.name}/`,
    }));
  },
};

// ---------- PullPush ----------

const PP_SORT = { new: ["created_utc", "desc"], old: ["created_utc", "asc"], top: ["score", "desc"], comments: ["num_comments", "desc"] };

export const pullpush = {
  name: "pullpush",

  async searchPosts({ query, subreddit, author, after, before, limit, sort, orderBy, deadline }) {
    const [sortType, dir] = PP_SORT[orderBy] || ["created_utc", sort === "asc" ? "asc" : "desc"];
    const url = buildUrl(PULLPUSH, "reddit/search/submission/", {
      q: query,
      subreddit,
      author,
      after,
      before,
      size: clampLimit(limit),
      sort: dir,
      sort_type: sortType,
    });
    return unwrap(await getJson(url, deadline)).map((p) => normalizePost(p, this.name));
  },

  async searchComments({ query, subreddit, author, postId, after, before, limit, sort, orderBy, deadline }) {
    const [sortType, dir] =
      orderBy === "top" ? ["score", "desc"] : ["created_utc", sort === "asc" || orderBy === "old" ? "asc" : "desc"];
    const url = buildUrl(PULLPUSH, "reddit/search/comment/", {
      q: query,
      subreddit,
      author,
      link_id: postId,
      after,
      before,
      size: clampLimit(limit),
      sort: dir,
      sort_type: sortType,
    });
    return unwrap(await getJson(url, deadline)).map((c) => normalizeComment(c, this.name));
  },
};

// Share of the remaining time a source may use when another source is still
// waiting behind it. Live runs showed Arctic Shift's keyword post search can
// time out server-side for a minute at a time; without a cap, its retries ate
// the whole call budget before PullPush was ever tried.
const PRIMARY_SHARE = 0.6;

// Try each source in order; return the first that answers, plus notes on failures
// so the model (and the user) can see when a fallback happened.
export async function firstAvailable(sources, method, args) {
  const notes = [];
  for (const [i, src] of sources.entries()) {
    const isLast = i === sources.length - 1;
    const deadline =
      !isLast && args.deadline !== undefined
        ? Date.now() + Math.floor((args.deadline - Date.now()) * PRIMARY_SHARE)
        : args.deadline;
    try {
      const items = await src[method]({ ...args, deadline });
      return { items, source: src.name, notes };
    } catch (e) {
      notes.push(`${src.name}: ${e.message}`);
    }
  }
  const err = new Error(`All sources failed. ${notes.join(" | ")}`);
  err.notes = notes;
  throw err;
}
