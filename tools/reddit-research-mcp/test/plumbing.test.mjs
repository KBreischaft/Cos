// Offline end-to-end plumbing test: real MCP client <-> real server over stdio,
// with both archives replaced by local fakes. Proves protocol, parsing, fallback,
// retry, and ranking logic. Does NOT prove the live archives respond this way;
// run `npm run smoke` for that.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { start, log, setArcticMode } from "./fake-archives.mjs";

let fakes, client;
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  return { isError: !!r.isError, text, json: r.isError ? null : JSON.parse(text) };
};

before(async () => {
  fakes = await start();
  client = new Client({ name: "plumbing-test", version: "0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/index.js", import.meta.url))],
    env: { ...process.env, ARCTIC_SHIFT_BASE_URL: fakes.arcticUrl, PULLPUSH_BASE_URL: fakes.pullpushUrl, REDDIT_MCP_MAX_RETRIES: "1", HTTP_PROXY: "", HTTPS_PROXY: "", http_proxy: "", https_proxy: "" },
  }));
});
after(async () => { await client?.close(); fakes?.close(); });

test("lists all five tools", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["reddit_find_subreddits", "reddit_get_thread", "reddit_research_topic", "reddit_search_comments", "reddit_search_posts"]);
});

test("scoped post search uses Arctic Shift and converts dates", async () => {
  log.length = 0;
  const r = await call("reddit_search_posts", { query: "EIDL default", subreddit: "r/EIDL", after: "2021-01-01" });
  assert.equal(r.json.source, "arctic_shift");
  assert.equal(r.json.count, 2);
  assert.equal(r.json.results[0].id, "bbb222"); // newest first
  assert.match(log[0], /subreddit=EIDL/);
  assert.match(log[0], /after=1609459200/);
  assert.equal(r.json.results[0].permalink, "https://www.reddit.com/r/EIDL/comments/bbb222/x/");
});

test("site-wide post search goes straight to PullPush (Arctic rejects unscoped search)", async () => {
  log.length = 0;
  const r = await call("reddit_search_posts", { query: "EIDL treasury offset" });
  assert.equal(r.json.source, "pullpush");
  assert.ok(!log.some((l) => l.startsWith("arctic")), "no wasted Arctic call");
});

test("forced Arctic Shift on unscoped search surfaces the archive's error text", async () => {
  const r = await call("reddit_search_posts", { query: "EIDL", source: "arctic_shift" });
  assert.equal(r.isError, true);
  assert.match(r.text, /HTTP 400 .*query requires subreddit or author/);
});

test("order_by=top goes to PullPush first and ranks by score", async () => {
  const r = await call("reddit_search_posts", { query: "EIDL", subreddit: "EIDL", order_by: "top" });
  assert.equal(r.json.source, "pullpush");
  assert.equal(r.json.results[0].score, 300);
});

test("unscoped comment search uses PullPush; scoped uses Arctic", async () => {
  const g = await call("reddit_search_comments", { query: "cross-servicing" });
  assert.equal(g.json.source, "pullpush");
  const s = await call("reddit_search_comments", { query: "hardship", subreddit: "EIDL" });
  assert.equal(s.json.source, "arctic_shift");
  assert.equal(s.json.results[0].post_id, "aaa111");
});

test("429 with X-RateLimit-Reset is retried", async () => {
  setArcticMode("429once");
  const r = await call("reddit_search_posts", { query: "EIDL", subreddit: "EIDL" });
  setArcticMode("ok");
  assert.equal(r.json.source, "arctic_shift");
});

test("422 (Arctic overload) is retried", async () => {
  setArcticMode("422once");
  const r = await call("reddit_search_posts", { query: "EIDL", subreddit: "EIDL" });
  setArcticMode("ok");
  assert.equal(r.json.source, "arctic_shift");
});

test("research_topic respects its time budget and reports skipped searches", async () => {
  setArcticMode("slow"); // each Arctic call takes 1.5s
  const qs = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
  const t0 = Date.now();
  const r = await call("reddit_research_topic", { queries: qs, subreddits: ["EIDL", "PPP", "SBA", "smallbusiness"], include_sitewide: false, time_budget_s: 10 });
  setArcticMode("ok");
  assert.equal(r.json.searches_planned, 80);
  assert.ok(r.json.searches_run > 0 && r.json.searches_run < 80, `ran ${r.json.searches_run}`);
  assert.match(r.json.notes[0], /Time budget \(10s\) reached/);
  assert.ok(Date.now() - t0 < 15000, "returned near the budget");
});

test("Arctic outage on scoped search falls back to PullPush", async () => {
  setArcticMode("down");
  const r = await call("reddit_search_posts", { query: "EIDL", subreddit: "EIDL" });
  setArcticMode("ok");
  assert.equal(r.json.source, "pullpush");
});

test("get_thread accepts a URL and flattens the tree", async () => {
  const r = await call("reddit_get_thread", { post: "https://www.reddit.com/r/EIDL/comments/abc123/some_title/" });
  assert.equal(r.json.post.id, "abc123");
  assert.equal(r.json.comment_count, 2);
  assert.deepEqual(r.json.comments.map((c) => c.depth), [0, 1, 1]);
  assert.ok(r.json.notes.some((n) => n.includes("7 comments not expanded")));
});

test("find_subreddits", async () => {
  const r = await call("reddit_find_subreddits", { prefix: "eidl" });
  assert.equal(r.json.results[0].name, "EIDL");
});

test("research_topic fans out, dedupes, and summarizes", async () => {
  log.length = 0;
  const r = await call("reddit_research_topic", { queries: ["EIDL default", "treasury offset"], subreddits: ["EIDL"], after: "2020-03-01" });
  // 2 queries x 2 scopes (r/EIDL + site-wide) x 2 kinds
  assert.equal(r.json.searches_run, 8);
  assert.equal(r.json.searches_planned, 8);
  const ids = r.json.top_posts.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "no duplicate posts");
  assert.equal(r.json.top_posts[0].id, "ppp333"); // highest engagement
  assert.ok(r.json.by_subreddit.EIDL > 0);
  assert.ok(Object.keys(r.json.by_month).every((k) => /^\d{4}-\d{2}$/.test(k)));
});

test("bad input returns a clean tool error", async () => {
  const r = await call("reddit_get_thread", { post: "not a post!" });
  assert.equal(r.isError, true);
  assert.match(r.text, /Could not find a Reddit post id/);
});
