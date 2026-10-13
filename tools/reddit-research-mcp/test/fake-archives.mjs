// Fake Arctic Shift + PullPush HTTP servers for offline plumbing tests.
// Shapes follow the documented APIs; data is synthetic.
import http from "node:http";

const post = (id, sub, title, score, nc, t) => ({ id, subreddit: sub, author: "u_" + id, title, selftext: "body of " + title, score, num_comments: nc, created_utc: t, permalink: `/r/${sub}/comments/${id}/x/` });
const comment = (id, link, sub, body, score, t, replies) => ({ kind: "t1", data: { id, link_id: "t3_" + link, parent_id: "t3_" + link, subreddit: sub, author: "c_" + id, body, score, created_utc: t, permalink: `/r/${sub}/comments/${link}/x/${id}/`, replies: replies ? { kind: "Listing", data: { children: replies } } : "" } });

export const log = [];
export const concurrency = { arctic: 0, arcticMax: 0 };
let arcticMode = "ok"; // ok | 429once | 422once | down | slow
export const setArcticMode = (m) => { arcticMode = m; hits429 = 0; };
let hits429 = 0;

function countedArctic(req, res) {
  concurrency.arctic++;
  concurrency.arcticMax = Math.max(concurrency.arcticMax, concurrency.arctic);
  res.on("finish", () => concurrency.arctic--);
  setTimeout(() => arcticHandler(req, res), 40); // window in which overlapping requests would show

}

function arcticHandler(req, res) {
  const u = new URL(req.url, "http://x");
  log.push("arctic " + u.pathname + u.search);
  const send = (code, obj, headers = {}) => { res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(obj)); };
  if (arcticMode === "down") return send(503, { error: "maintenance" });
  if (arcticMode === "429once" && hits429++ === 0) return send(429, { error: "rate limited" }, { "x-ratelimit-reset": "1" });
  if (arcticMode === "422once" && hits429++ === 0) return send(422, { error: "Timeout. Maybe slow down a bit" });
  if (arcticMode === "slow") return setTimeout(() => { arcticMode = "ok"; arcticHandler(req, res); arcticMode = "slow"; }, 1500);
  const p = u.searchParams;
  if (u.pathname === "/api/posts/search") {
    if (!p.get("subreddit") && !p.get("author")) return send(400, { error: "query requires subreddit or author" });
    return send(200, { data: [post("aaa111", p.get("subreddit"), "EIDL default help", 40, 12, 1640000000), post("bbb222", p.get("subreddit"), "Treasury offset after EIDL", 90, 55, 1700000000)] });
  }
  if (u.pathname === "/api/comments/search") {
    if (!p.get("body")) return send(400, { error: "missing body" });
    return send(200, { data: [comment("c1", "aaa111", p.get("subreddit") || "EIDL", "We got a hardship accommodation", 33, 1650000000).data] });
  }
  if (u.pathname === "/api/posts/ids") return send(200, { data: [post(p.get("ids"), "EIDL", "Full thread title", 120, 3, 1660000000)] });
  if (u.pathname === "/api/comments/tree") {
    return send(200, { data: [comment("t1", p.get("link_id"), "EIDL", "top level", 10, 1660000100, [comment("t2", p.get("link_id"), "EIDL", "reply", 5, 1660000200), { kind: "more", data: { count: 7, children: [] } }])] });
  }
  if (u.pathname === "/api/subreddits/search") return send(200, { data: [{ display_name: "EIDL", subscribers: 20000, public_description: "EIDL loans", created_utc: 1590000000 }] });
  send(404, { error: "not found" });
}

function pullpushHandler(req, res) {
  const u = new URL(req.url, "http://x");
  log.push("pullpush " + u.pathname + u.search);
  const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  const p = u.searchParams;
  if (u.pathname === "/reddit/search/submission/") return send(200, { data: [post("ppp333", p.get("subreddit") || "smallbusiness", "SBA sent my EIDL to Treasury", 300, 120, 1710000000), post("aaa111", "EIDL", "EIDL default help", 40, 12, 1640000000)] });
  if (u.pathname === "/reddit/search/comment/") return send(200, { data: [comment("pc1", "ppp333", "smallbusiness", "Cross-Servicing took my refund", 80, 1712000000).data] });
  send(404, { error: "not found" });
}

export async function start() {
  const a = http.createServer(countedArctic);
  const b = http.createServer(pullpushHandler);
  await new Promise((r) => a.listen(0, "127.0.0.1", r));
  await new Promise((r) => b.listen(0, "127.0.0.1", r));
  return { arcticUrl: `http://127.0.0.1:${a.address().port}`, pullpushUrl: `http://127.0.0.1:${b.address().port}`, close: () => { a.close(); b.close(); } };
}
