# Reddit Research MCP

Read-only MCP server that lets Claude run deep research on Reddit: keyword search
across posts and comments, full threads, and multi-query topic sweeps with
breakdowns by subreddit and month. Built first for SBA COVID loan (EIDL/PPP)
default research, but works for any topic.

## Why it reads archives, not Reddit

- Reddit shut off unauthenticated `.json` access in May 2026.
- Reddit stops accepting new Data API requests on 2026-10-31 and ends public API
  access in March 2027.

So this server reads the two public Reddit archives instead. Neither needs a key.

| Source | Role | Strengths | Limits |
|---|---|---|---|
| [Arctic Shift](https://github.com/ArthurHeitmann/arctic_shift) | Primary for scoped search | Near-real-time, full comment trees, scoped keyword search on posts and comments | Sorts by date only. Keyword search needs a subreddit, author or post (site-wide returns 400). Scores settle about 36h after posting. Throttles with 422/429. |
| [PullPush](https://pullpush.io) | Site-wide search, and fallback | Site-wide keyword search on posts and comments, sort by score | Throttles with 403. History of multi-week outages. |

`source: "auto"` (default) picks the best archive for each call and falls back
automatically. Every response says which source answered and notes any fallback.
Throttling responses (403, 422, 429, 5xx) are retried with backoff.

**Pacing (polite by design).** Requests to each archive run one at a time, at
least 1s apart for Arctic Shift and 3s apart for PullPush, and a throttle backs off
the whole queue. Live tests with parallel requests got "Timeout. Maybe slow down a
bit" from Arctic Shift and a 429 from PullPush stating it "does not provide free
scraping resources for agents" (it points heavy users to its admin on Discord).
Keep PullPush as a low-volume fallback, or set `REDDIT_MCP_DISABLE_PULLPUSH=1` to
honor that policy strictly. For regular heavy use, ask the PullPush admin for access. Tune with `REDDIT_MCP_MIN_GAP_MS` and
`REDDIT_MCP_PULLPUSH_GAP_MS`.

## Tools

| Tool | Use it for |
|---|---|
| `reddit_research_topic` | Start here. Runs up to 10 keyword variants across up to 15 subreddits plus site-wide, posts and comments, deduped. Returns top posts, top comments, counts by subreddit and by month. Hard-stops at `time_budget_s` (default 50s, keeps under client timeouts), returns what it found, and says how many searches it skipped. Because of pacing, expect roughly 15 to 25 searches per 50s; raise the budget for bigger sweeps. |
| `reddit_search_posts` | Targeted post search with date range and `order_by` new/old/top/comments. |
| `reddit_search_comments` | First-hand accounts. Scope to a subreddit, author or post for best results. |
| `reddit_get_thread` | One post plus its full comment tree. Accepts an id or any Reddit URL. |
| `reddit_find_subreddits` | Find communities by name prefix (e.g. `eidl`, `sba`), largest first. |

Dates accept `YYYY-MM-DD`, ISO, epoch seconds, or relative (`90d`, `6months`, `1year`).
Keyword syntax: `"exact phrase"`, `OR`, `-exclude`.

### Example prompt

> Use reddit_research_topic with queries ["EIDL default", "EIDL treasury offset",
> "EIDL Cross-Servicing", "SBA hardship accommodation", "PPP loan default"],
> subreddits ["EIDL", "PPP", "smallbusiness", "SBA", "Entrepreneur"], after 2020-03-01.
> Then open the five most-discussed threads and summarize what borrowers report
> about collections, offsets, and settlement (offer in compromise) outcomes.

## Install (Windows, one command)

Requires Node.js 18+. From the repo root in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\reddit-research-mcp\scripts\install.ps1
```

It installs dependencies, runs the live smoke test, registers the server with
Claude Code (user scope) if the `claude` CLI is present, and adds it to Claude
Desktop's `%APPDATA%\Claude\claude_desktop_config.json` (backed up first; other
servers untouched). Re-run any time; it is idempotent. Quit and reopen Claude
Desktop afterward.

Flags: `-SkipSmoke`, `-SkipClaudeCode`, `-SkipDesktop`, `-DesktopConfigPath <path>`.

### Manual registration

```bash
npm install --omit=dev
claude mcp add --scope user --transport stdio reddit-research -- node /abs/path/to/src/index.js
```

### Claude Code on the web (cloud sessions)

The cloud environment's network policy must allow `arctic-shift.photon-reddit.com`
and `api.pullpush.io`. Node's built-in fetch also needs `NODE_USE_ENV_PROXY=1` there
to route through the session proxy.

## Testing

| Command | What it proves |
|---|---|
| `npm test` | Offline. A real MCP client drives the server over stdio against local fake archives: tool listing, date parsing, source routing, fallback, 429 retry, thread flattening, research dedupe and ranking, error handling. |
| `npm run smoke` | Live. Same stdio round-trip against the real archives with SBA/EIDL queries. Exit code 0 means every check passed. |
| `npm run sample` | Live. One full SBA COVID loan default research sweep, printed as a digest. |

CI (`.github/workflows/reddit-research-mcp.yml`) runs all three on Linux and Windows
on every push that touches this folder, then runs `install.ps1` under Windows
PowerShell 5.1 against a sample Claude Desktop config and launches the server from
the config it wrote.

## Configuration (env vars, all optional)

| Var | Default |
|---|---|
| `ARCTIC_SHIFT_BASE_URL` | `https://arctic-shift.photon-reddit.com` |
| `PULLPUSH_BASE_URL` | `https://api.pullpush.io` |
| `REDDIT_MCP_TIMEOUT_MS` | `30000` |
| `REDDIT_MCP_MAX_RETRIES` | `3` (backoff, honors `X-RateLimit-Reset`) |
| `REDDIT_MCP_DISABLE_PULLPUSH` | unset (`1` = never call PullPush; site-wide search then needs a subreddit or author) |
| `REDDIT_MCP_DEBUG` | unset (`1` = log every request with status and latency to stderr) |
| `REDDIT_MCP_CALL_BUDGET_MS` | `45000` (hard cap per search/thread/subreddit call, including retries) |
| `REDDIT_MCP_MIN_GAP_MS` | `1000` (per-host gap; Arctic Shift) |
| `REDDIT_MCP_PULLPUSH_GAP_MS` | `3000` |
| `REDDIT_MCP_USER_AGENT` | `reddit-research-mcp/0.1 (...)` |

## Known limits and next steps

- Archives can lag or go down; `auto` mode falls back, but if both are down the call fails with the reason.
- Deleted or removed content shows as `[deleted]` / `[removed]`.
- If both archives become unreliable, add a paid live source (an Apify Reddit actor at
  roughly $0.50 to $2 per 1,000 results) as a third backend in `src/sources.js`.
- Archive data is for research. Don't republish usernames or quotes in client deliverables without anonymizing.
