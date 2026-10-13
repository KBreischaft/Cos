// Live end-to-end check: launches the server over stdio exactly as Claude does,
// then hits the REAL archives with an SBA/EIDL research query.
// Usage: npm run smoke            Exit code 0 = every check passed.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const server = fileURLToPath(new URL("../src/index.js", import.meta.url));
const client = new Client({ name: "smoke-live", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], env: process.env, stderr: "inherit" }));

let failed = 0;
let rateLimited = 0;
// An upstream 429 is the archive declining service (PullPush throttles shared
// cloud IPs), not a defect in this server. With { soft: true } it is reported
// as RATE-LIMITED instead of FAIL; any other error still fails the run.
async function check(label, tool, args, assertFn, { soft = false } = {}) {
  const t0 = Date.now();
  try {
    const r = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 180000 });
    const text = r.content[0].text;
    if (r.isError) throw new Error(text);
    const json = JSON.parse(text);
    const detail = assertFn(json);
    console.log(`PASS  ${label}  (${Date.now() - t0} ms)  ${detail}`);
    return json;
  } catch (e) {
    const msg = String(e.message);
    if (soft && /HTTP 429/.test(msg) && !/HTTP (?!429)\d{3}/.test(msg)) {
      rateLimited++;
      console.log(`RATE-LIMITED  ${label}  (${Date.now() - t0} ms)  ${msg.slice(0, 200)}`);
      return null;
    }
    failed++;
    console.log(`FAIL  ${label}  (${Date.now() - t0} ms)  ${msg.slice(0, 400)}`);
  }
}
const need = (cond, msg) => { if (!cond) throw new Error(msg); };

// User path: auto mode, exactly what Claude gets. These must pass.
const posts = await check("Posts in r/EIDL (auto)", "reddit_search_posts",
  { query: "default", subreddit: "EIDL", limit: 10 },
  (j) => { need(j.count > 0, "no results"); return `${j.count} via ${j.source}, newest ${j.results[0].created?.slice(0, 10)}: "${j.results[0].title.slice(0, 60)}"${j.notes.length ? " | notes: " + j.notes.join("; ").slice(0, 200) : ""}`; });

await check("Comments in r/EIDL (auto)", "reddit_search_comments",
  { query: "treasury offset", subreddit: "EIDL", limit: 10 },
  (j) => { need(j.count > 0, "no results"); return `${j.count} via ${j.source}`; });

const sitePosts = await check("Site-wide posts (auto)", "reddit_search_posts",
  { query: "EIDL default", limit: 10 },
  (j) => { need(j.count > 0, "no results"); return `${j.count} via ${j.source} across ${new Set(j.results.map((r) => r.subreddit)).size} subreddits`; },
  { soft: true });

const siteComments = await check("Site-wide comments (auto)", "reddit_search_comments",
  { query: "EIDL hardship accommodation", limit: 10 },
  (j) => { need(j.count > 0, "no results"); return `${j.count} via ${j.source}`; },
  { soft: true });

// Site-wide search must be proven working at least once per run.
if (!sitePosts && !siteComments) {
  failed++;
  console.log("FAIL  Site-wide search: neither posts nor comments succeeded this run");
}

const threadId = posts?.results?.find((p) => p.num_comments > 0)?.id || posts?.results?.[0]?.id;
if (threadId) {
  await check("Full thread", "reddit_get_thread", { post: threadId, max_comments: 200 },
    (j) => { need(j.post?.id === threadId, "wrong post"); need(j.comment_count > 0 || j.post.num_comments === 0, "no comments returned"); return `"${(j.post.title || "").slice(0, 50)}" with ${j.comment_count} comments`; });
} else { failed++; console.log("FAIL  Full thread  (no post id from first check)"); }

// Source health: informational only. One archive being slow is expected; the
// auto checks above prove the fallback covers it.
async function info(label, tool, args) {
  const t0 = Date.now();
  const r = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 180000 });
  const text = r.content[0].text;
  const ok = !r.isError && JSON.parse(text).count > 0;
  console.log(`${ok ? "INFO " : "WARN "} ${label}  (${Date.now() - t0} ms)  ${ok ? "up" : text.slice(0, 200)}`);
}
await info("Arctic Shift keyword posts", "reddit_search_posts", { query: "default", subreddit: "EIDL", limit: 5, source: "arctic_shift" });
await info("PullPush keyword posts", "reddit_search_posts", { query: "EIDL default", limit: 5, source: "pullpush" });

await check("Arctic Shift: find subreddits", "reddit_find_subreddits", { prefix: "eidl", limit: 5 },
  (j) => { need(j.count > 0, "no results"); return j.results.map((s) => `r/${s.name} (${s.subscribers})`).join(", "); });

await check("Research sweep: SBA COVID loans in default", "reddit_research_topic",
  { queries: ["EIDL default", "EIDL treasury offset", "SBA hardship accommodation"], subreddits: ["EIDL", "smallbusiness", "SBA"], after: "2020-03-01", per_search_limit: 25, top_n: 10 },
  (j) => { need(j.totals.posts + j.totals.comments > 0, "no results"); return `${j.searches_run} searches -> ${j.totals.posts} posts, ${j.totals.comments} comments; top: "${(j.top_posts[0]?.title || j.top_comments[0]?.text || '').slice(0, 60)}"; ${j.notes.length} notes`; });

await client.close();
if (rateLimited) console.log(`\n${rateLimited} check(s) rate-limited by an upstream archive (reported, not counted as failures).`);
console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll required live checks passed.");
process.exit(failed ? 1 : 0);
