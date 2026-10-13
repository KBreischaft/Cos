// Times Arctic Shift and PullPush across query shapes to tune defaults.
// Sequential with a 2s gap; each request is a single attempt (no retries).
// Usage: node scripts/diagnose-arctic.mjs
const A = "https://arctic-shift.photon-reddit.com";
const P = "https://api.pullpush.io";
const UA = "reddit-research-mcp/0.1 (+https://github.com/kbreischaft/cos)";
const cases = [
  ["A posts q=default sub=EIDL limit=10", `${A}/api/posts/search?subreddit=EIDL&query=default&limit=10`],
  ["A posts q=default sub=EIDL limit=10 (repeat)", `${A}/api/posts/search?subreddit=EIDL&query=default&limit=10`],
  ["A posts q=default sub=EIDL limit=100", `${A}/api/posts/search?subreddit=EIDL&query=default&limit=100`],
  ["A posts q=default sub=EIDL after=2020-03-01 limit=50", `${A}/api/posts/search?subreddit=EIDL&query=default&after=1583020800&limit=50`],
  ["A posts q=default sub=EIDL after=90d limit=50", `${A}/api/posts/search?subreddit=EIDL&query=default&after=90d&limit=50`],
  ["A posts q='default OR offset' sub=EIDL limit=50", `${A}/api/posts/search?subreddit=EIDL&query=${encodeURIComponent("default OR offset")}&limit=50`],
  ["A posts title=default sub=EIDL limit=50", `${A}/api/posts/search?subreddit=EIDL&title=default&limit=50`],
  ["A posts sub=EIDL no keyword limit=100", `${A}/api/posts/search?subreddit=EIDL&limit=100`],
  ["A posts q=EIDL sub=smallbusiness limit=50", `${A}/api/posts/search?subreddit=smallbusiness&query=EIDL&limit=50`],
  ["A comments body=default sub=EIDL limit=50", `${A}/api/comments/search?subreddit=EIDL&body=default&limit=50`],
  ["A comments body='default OR offset' sub=EIDL limit=50", `${A}/api/comments/search?subreddit=EIDL&body=${encodeURIComponent("default OR offset")}&limit=50`],
  ["A comments body=EIDL sub=smallbusiness limit=50", `${A}/api/comments/search?subreddit=smallbusiness&body=EIDL&limit=50`],
  ["P posts q=EIDL default size=50", `${P}/reddit/search/submission/?q=${encodeURIComponent("EIDL default")}&size=50`],
  ["P posts q='EIDL default|treasury offset' size=50", `${P}/reddit/search/submission/?q=${encodeURIComponent("EIDL (default|offset)")}&size=50`],
  ["P comments q=EIDL default size=50", `${P}/reddit/search/comment/?q=${encodeURIComponent("EIDL default")}&size=50`],
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const [label, url] of cases) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(60000) });
    const text = await res.text();
    let n = "?";
    try { n = JSON.parse(text).data?.length ?? "no data"; } catch {}
    const rl = ["x-ratelimit-remaining", "x-ratelimit-reset"].map((h) => `${h.split("-").pop()}=${res.headers.get(h)}`).join(" ");
    console.log(`${String(Date.now() - t0).padStart(6)}ms  ${res.status}  n=${n}  ${rl}  ${label}${res.ok ? "" : "  body=" + text.slice(0, 120).replace(/\s+/g, " ")}`);
  } catch (e) {
    console.log(`${String(Date.now() - t0).padStart(6)}ms  ERR ${e.name}  ${label}`);
  }
  await sleep(2000);
}
