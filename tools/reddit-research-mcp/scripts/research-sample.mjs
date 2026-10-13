// Runs one real research sweep through the MCP server and prints a readable digest.
// Usage: node scripts/research-sample.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const client = new Client({ name: "research-sample", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../src/index.js", import.meta.url))], env: process.env }));
const r = await client.callTool({
  name: "reddit_research_topic",
  arguments: {
    queries: ["EIDL default", "EIDL treasury offset", "EIDL Cross-Servicing", "SBA hardship accommodation", "PPP loan default"],
    subreddits: ["EIDL", "PPP", "smallbusiness", "SBA"],
    after: "2020-03-01",
    per_search_limit: 50,
    top_n: 15,
  },
});
await client.close();
if (r.isError) { console.log(r.content[0].text); process.exit(1); }
const j = JSON.parse(r.content[0].text);
console.log(`Searches: ${j.searches_run} | posts: ${j.totals.posts} | comments: ${j.totals.comments}`);
console.log("By subreddit:", JSON.stringify(j.by_subreddit));
console.log("By month:", JSON.stringify(j.by_month));
console.log("\nTop posts:");
for (const p of j.top_posts) console.log(`  [${p.created?.slice(0, 10)}] r/${p.subreddit} score ${p.score} / ${p.num_comments} comments: ${p.title.slice(0, 90)}\n    ${p.permalink}`);
console.log("\nTop comments:");
for (const c of j.top_comments.slice(0, 8)) console.log(`  [${c.created?.slice(0, 10)}] r/${c.subreddit} score ${c.score}: ${c.text.slice(0, 160)}`);
if (j.notes.length) console.log("\nNotes:\n  " + j.notes.join("\n  "));
process.exit(j.totals.posts + j.totals.comments > 0 ? 0 : 1);
