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
async function check(label, tool, args, assertFn) {
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
    failed++;
    console.log(`FAIL  ${label}  (${Date.now() - t0} ms)  ${String(e.message).slice(0, 400)}`);
  }
}
const need = (cond, msg) => { if (!cond) throw new Error(msg); };

const posts = await check("Arctic Shift: posts in r/EIDL", "reddit_search_posts",
  { query: "default", subreddit: "EIDL", limit: 10, source: "arctic_shift" },
  (j) => { need(j.count > 0, "no results"); return `${j.count} posts, newest ${j.results[0].created?.slice(0, 10)}: "${j.results[0].title.slice(0, 60)}"`; });

await check("Arctic Shift: comments in r/EIDL", "reddit_search_comments",
  { query: "treasury offset", subreddit: "EIDL", limit: 10, source: "arctic_shift" },
  (j) => { need(j.count > 0, "no results"); return `${j.count} comments`; });

await check("PullPush: site-wide posts", "reddit_search_posts",
  { query: "EIDL default", limit: 10, source: "pullpush" },
  (j) => { need(j.count > 0, "no results"); return `${j.count} posts across ${new Set(j.results.map((r) => r.subreddit)).size} subreddits`; });

await check("PullPush: site-wide comments", "reddit_search_comments",
  { query: "EIDL hardship accommodation", limit: 10, source: "pullpush" },
  (j) => { need(j.count > 0, "no results"); return `${j.count} comments`; });

await check("Auto: site-wide posts (fallback chain)", "reddit_search_posts",
  { query: "EIDL Cross-Servicing", limit: 10 },
  (j) => { need(j.count > 0, "no results"); return `${j.count} via ${j.source}${j.notes.length ? " | notes: " + j.notes.join("; ") : ""}`; });

const threadId = posts?.results?.find((p) => p.num_comments > 0)?.id || posts?.results?.[0]?.id;
if (threadId) {
  await check("Arctic Shift: full thread", "reddit_get_thread", { post: threadId, max_comments: 200 },
    (j) => { need(j.post?.id === threadId, "wrong post"); return `"${(j.post.title || "").slice(0, 50)}" with ${j.comment_count} comments`; });
} else { failed++; console.log("FAIL  full thread  (no post id from first check)"); }

await check("Arctic Shift: find subreddits", "reddit_find_subreddits", { prefix: "eidl", limit: 5 },
  (j) => { need(j.count > 0, "no results"); return j.results.map((s) => `r/${s.name} (${s.subscribers})`).join(", "); });

await check("Research sweep: SBA COVID loans in default", "reddit_research_topic",
  { queries: ["EIDL default", "EIDL treasury offset", "SBA hardship accommodation"], subreddits: ["EIDL", "smallbusiness", "SBA"], after: "2020-03-01", per_search_limit: 25, top_n: 10 },
  (j) => { need(j.totals.posts + j.totals.comments > 0, "no results"); return `${j.searches_run} searches -> ${j.totals.posts} posts, ${j.totals.comments} comments; top: "${(j.top_posts[0]?.title || j.top_comments[0]?.text || '').slice(0, 60)}"; ${j.notes.length} notes`; });

await client.close();
console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll live checks passed.");
process.exit(failed ? 1 : 0);
