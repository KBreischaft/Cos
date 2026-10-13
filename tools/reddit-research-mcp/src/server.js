// Reddit Research MCP server definition. Read-only search over the public Reddit
// archives (Arctic Shift primary, PullPush fallback). See README.md.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { arctic, pullpush, firstAvailable } from "./sources.js";
import { dedupe, parsePostId, toEpoch } from "./normalize.js";

export const VERSION = "0.1.0";

const SOURCES = { arctic_shift: arctic, pullpush };

// Hard cap per tool call (except the research sweep, which has its own budget),
// so a slow or throttling archive can't outlast the client's tool timeout.
const CALL_BUDGET_MS = Number(process.env.REDDIT_MCP_CALL_BUDGET_MS ?? 45000);
const callDeadline = () => Date.now() + CALL_BUDGET_MS;

const commonShape = {
  query: z.string().min(1).describe('Keywords. Supports "exact phrase", OR, and -exclude (archive syntax).'),
  subreddit: z.string().optional().describe("Limit to one subreddit, without r/ (e.g. EIDL)."),
  author: z.string().optional().describe("Limit to one username, without u/."),
  after: z.string().optional().describe('Start date: YYYY-MM-DD, ISO, epoch seconds, or relative like "90d", "1year".'),
  before: z.string().optional().describe("End date, same formats as `after`."),
  limit: z.number().int().min(1).max(100).default(25).describe("Max results (1-100)."),
  order_by: z
    .enum(["new", "old", "top", "comments"])
    .default("new")
    .describe("new/old = by date. top = by score. comments = by comment count (posts only)."),
  source: z
    .enum(["auto", "arctic_shift", "pullpush"])
    .default("auto")
    .describe("auto tries the best archive first and falls back on failure."),
};

function sourceOrder(source, { orderBy, scoped, kind }) {
  if (source !== "auto") return [SOURCES[source]];
  // Arctic Shift sorts by date only; for score ranking, or for unscoped comment
  // search (Arctic requires a scope), PullPush is the better first try.
  // Live-verified: Arctic Shift returns 400 for unscoped keyword search.
  if (!scoped) return [pullpush];
  if (orderBy === "top" || orderBy === "comments") return [pullpush, arctic];
  return [arctic, pullpush];
}

function rank(items, orderBy) {
  const by = {
    new: (a, b) => b.created_utc - a.created_utc,
    old: (a, b) => a.created_utc - b.created_utc,
    top: (a, b) => (b.score ?? 0) - (a.score ?? 0),
    comments: (a, b) => (b.num_comments ?? 0) - (a.num_comments ?? 0),
  }[orderBy];
  return by ? [...items].sort(by) : items;
}

function stripInternal(item) {
  const { created_utc, ...rest } = item;
  return rest;
}

const ok = (payload) => ({ content: [{ type: "text", text: JSON.stringify(payload, null, 1) }] });
const fail = (msg) => ({ content: [{ type: "text", text: msg }], isError: true });

async function runSearch(kind, a, deadline = callDeadline()) {
  const args = {
    deadline,
    query: a.query,
    subreddit: a.subreddit?.replace(/^\/?r\//i, ""),
    author: a.author?.replace(/^\/?u\//i, ""),
    postId: a.post ? parsePostId(a.post) : undefined,
    after: toEpoch(a.after),
    before: toEpoch(a.before),
    limit: a.limit,
    orderBy: a.order_by,
    sort: a.order_by === "old" ? "asc" : "desc",
  };
  const scoped = Boolean(args.subreddit || args.author || args.postId);
  const order = sourceOrder(a.source, { orderBy: a.order_by, scoped, kind });
  const method = kind === "posts" ? "searchPosts" : "searchComments";
  const res = await firstAvailable(order, method, args);
  const items = rank(res.items, a.order_by).map(stripInternal);
  const notes = [...res.notes];
  if (res.source === "arctic_shift" && (a.order_by === "top" || a.order_by === "comments")) {
    notes.push("Arctic Shift returns by date; ranking applied only within the fetched window.");
  }
  return { source: res.source, count: items.length, notes, results: items };
}

export function createServer() {
  const server = new McpServer({ name: "reddit-research", version: VERSION });

  server.registerTool(
    "reddit_search_posts",
    {
      title: "Search Reddit posts",
      description:
        "Keyword search over Reddit posts (titles and body text) from the public archives, any date back to 2005. " +
        "Returns title, excerpt, subreddit, date, score, comment count and permalink.",
      inputSchema: commonShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (a) => {
      try {
        return ok(await runSearch("posts", a));
      } catch (e) {
        return fail(`reddit_search_posts failed: ${e.message}`);
      }
    }
  );

  server.registerTool(
    "reddit_search_comments",
    {
      title: "Search Reddit comments",
      description:
        "Keyword search over Reddit comments. Comments hold most first-hand experience. " +
        "Scope with subreddit, author, or post for the most reliable results; unscoped search uses PullPush.",
      inputSchema: {
        ...commonShape,
        post: z.string().optional().describe("Limit to one post: id, t3_ id, or full Reddit URL."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (a) => {
      try {
        return ok(await runSearch("comments", a));
      } catch (e) {
        return fail(`reddit_search_comments failed: ${e.message}`);
      }
    }
  );

  server.registerTool(
    "reddit_get_thread",
    {
      title: "Get a full Reddit thread",
      description: "Fetch one post with its full comment tree (depth-annotated, in display order).",
      inputSchema: {
        post: z.string().describe("Post id, t3_ id, or any Reddit / redd.it URL."),
        max_comments: z.number().int().min(1).max(5000).default(500),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ post, max_comments }) => {
      try {
        const id = parsePostId(post);
        const deadline = callDeadline();
        const notes = [];
        let p = null;
        try {
          p = await arctic.getPost(id, deadline);
        } catch (e) {
          notes.push(`post lookup: ${e.message}`);
        }
        const comments = await arctic.getCommentTree(id, max_comments, deadline);
        const truncated = comments.filter((c) => c.type === "more").reduce((n, c) => n + c.count, 0);
        if (truncated) notes.push(`${truncated} comments not expanded by the archive.`);
        return ok({
          source: "arctic_shift",
          notes,
          post: p ? stripInternal(p) : { id, permalink: `https://www.reddit.com/comments/${id}/` },
          comment_count: comments.filter((c) => c.type === "comment").length,
          comments: comments.map((c) => (c.type === "comment" ? stripInternal(c) : c)),
        });
      } catch (e) {
        return fail(`reddit_get_thread failed: ${e.message}`);
      }
    }
  );

  server.registerTool(
    "reddit_find_subreddits",
    {
      title: "Find subreddits by name",
      description:
        "List subreddits whose names start with a prefix, largest first (e.g. 'sba', 'smallbus', 'eidl'). " +
        "Use to pick communities before a scoped search.",
      inputSchema: {
        prefix: z.string().min(1),
        min_subscribers: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(100).default(25),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ prefix, min_subscribers, limit }) => {
      try {
        const items = await arctic.findSubreddits({ prefix: prefix.replace(/^\/?r\//i, ""), minSubscribers: min_subscribers, limit, deadline: callDeadline() });
        return ok({ source: "arctic_shift", count: items.length, results: items });
      } catch (e) {
        return fail(`reddit_find_subreddits failed: ${e.message}`);
      }
    }
  );

  server.registerTool(
    "reddit_research_topic",
    {
      title: "Research a topic across Reddit",
      description:
        "Deep-research sweep: runs several keyword variants across chosen subreddits (and site-wide), " +
        "pulls posts and optionally comments, dedupes, and returns the most engaged items plus a breakdown " +
        "by subreddit and by month. Start here for open-ended research, then use reddit_get_thread on the best threads.",
      inputSchema: {
        queries: z
          .array(z.string().min(1))
          .min(1)
          .max(10)
          .describe('Keyword variants, e.g. ["EIDL default", "EIDL \\"treasury offset\\"", "SBA hardship accommodation"].'),
        subreddits: z
          .array(z.string())
          .max(15)
          .default([])
          .describe("Subreddits to sweep (without r/). Empty = site-wide only."),
        include_sitewide: z.boolean().default(true).describe("Also search across all of Reddit."),
        include_comments: z.boolean().default(true),
        after: z.string().optional(),
        before: z.string().optional(),
        per_search_limit: z.number().int().min(5).max(100).default(50),
        top_n: z.number().int().min(5).max(100).default(30),
        time_budget_s: z
          .number()
          .int()
          .min(10)
          .max(600)
          .default(50)
          .describe("Stop launching new searches after this many seconds and return what was found (keeps under client timeouts)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (a, extra) => {
      const deadline = Date.now() + a.time_budget_s * 1000;
      const progressToken = extra?._meta?.progressToken;
      const progress = async (done, total) => {
        if (progressToken === undefined) return;
        try {
          await extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress: done, total } });
        } catch {}
      };
      const scopes = [...a.subreddits.map((s) => s.replace(/^\/?r\//i, "")), ...(a.include_sitewide || !a.subreddits.length ? [undefined] : [])];
      const jobs = [];
      for (const q of a.queries) {
        for (const sub of scopes) {
          const base = { query: q, subreddit: sub, after: a.after, before: a.before, limit: a.per_search_limit, order_by: "new", source: "auto" };
          jobs.push({ kind: "posts", q, sub, args: base });
          if (a.include_comments) jobs.push({ kind: "comments", q, sub, args: base });
        }
      }
      // Run a few at a time to stay polite with the archives' rate limits.
      const results = [];
      const errors = [];
      const CONCURRENCY = 4;
      let skipped = 0;
      for (let i = 0; i < jobs.length; i += CONCURRENCY) {
        if (Date.now() >= deadline) {
          skipped += jobs.length - i;
          break;
        }
        const batch = jobs.slice(i, i + CONCURRENCY);
        const settled = await Promise.allSettled(batch.map((j) => runSearch(j.kind, j.args, deadline)));
        settled.forEach((s, k) => {
          const j = batch[k];
          const label = `${j.kind} "${j.q}" in ${j.sub ? "r/" + j.sub : "all of Reddit"}`;
          if (s.status === "fulfilled") {
            for (const it of s.value.results) results.push({ ...it, matched_query: j.q });
            if (s.value.notes.length) errors.push(`${label}: ${s.value.notes.join("; ")}`);
          } else if (/Time budget reached/.test(s.reason?.message)) {
            skipped++;
          } else {
            errors.push(`${label}: ${s.reason?.message || s.reason}`);
          }
        });
        await progress(Math.min(i + CONCURRENCY, jobs.length), jobs.length);
      }
      if (skipped) {
        errors.unshift(`Time budget (${a.time_budget_s}s) reached: ${skipped} of ${jobs.length} searches not run. Narrow the queries/subreddits or raise time_budget_s.`);
      }
      if (!results.length) {
        return fail(`reddit_research_topic found nothing. Errors: ${errors.join(" | ") || "none (no matches)"}`);
      }
      const all = dedupe(results);
      const posts = all.filter((x) => x.type === "post");
      const comments = all.filter((x) => x.type === "comment");
      const engagement = (x) => (x.score ?? 0) + 2 * (x.num_comments ?? 0);
      const tally = (arr, keyFn) =>
        Object.entries(arr.reduce((m, x) => ((m[keyFn(x)] = (m[keyFn(x)] || 0) + 1), m), {})).sort((p, q) => q[1] - p[1]);
      return ok({
        searches_run: jobs.length - skipped,
        searches_planned: jobs.length,
        totals: { posts: posts.length, comments: comments.length },
        by_subreddit: Object.fromEntries(tally(all, (x) => x.subreddit).slice(0, 20)),
        by_month: Object.fromEntries(tally(all, (x) => (x.created || "unknown").slice(0, 7)).sort((p, q) => p[0].localeCompare(q[0]))),
        top_posts: [...posts].sort((x, y) => engagement(y) - engagement(x)).slice(0, a.top_n),
        top_comments: [...comments].sort((x, y) => (y.score ?? 0) - (x.score ?? 0)).slice(0, a.top_n),
        notes: errors,
      });
    }
  );

  return server;
}
