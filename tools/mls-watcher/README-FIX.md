> **Superseded on 2026-10-01.** Kyle chose a sanctioned source instead: the watcher now reads
> the MLSSAZ public search (FlexMLS IDX) through `mls_portal.py` on the PC, with MLSSAZ's verbal
> OK for small checks (`config.json` `"source": "mls_portal"`). This kit was never applied and is
> kept only as a reference for a resilient HTTP fetch layer. Do not apply it to the watcher.

# DSD MLS watcher: Zillow 403 fix (2026-09-30)

## What broke
On 2026-09-29 every one of the watcher's three daily checks got `Zillow answered 403`
for all 14 homes, and at 7 PM Arizona time it emailed Kyle twelve "MLS watcher cannot
read ..." alerts. The same thing happened for two runs on 2026-09-27 and cleared by
itself. Zillow is protected by PerimeterX (HUMAN). The watcher used `httpx` with a
Chrome User-Agent string, and a Python TLS fingerprint under a Chrome name is one of
the standard signals that service blocks on, so the block was a matter of time.

## What changed
- `zfetch.py` (new, next to `watcher.py`): all Zillow reads go through it.
  1. `curl_cffi` with a genuine Chrome TLS/HTTP2 fingerprint, a cookie jar kept between
     runs (`cookies.json`), and a homepage warm-up on first use.
  2. On a 403 or a bot-check page: wait about a minute, drop cookies, switch fingerprint,
     retry once.
  3. Still blocked: load the page in the PC's own Google Chrome (Playwright, headless,
     profile folder `chrome-profile/`) and read the same listing JSON.
  4. Still blocked: the watcher logs `READ FAIL` and alerts after 3 runs, as before.
  Within one run a block is remembered, so a fully blocked run costs about 2 extra
  minutes, not 14 x 2. Log lines start with `SETUP` or `ZILLOW`.
- `watcher.py`: six anchored edits (see `patch_watcher.py`): `import zfetch`, log hookup,
  `zillow_get()` and the address lookup call `zfetch.get()`, and a new read-only
  `watcher.py check` command. Nothing else in the file is touched.
- Packages added to the gmail-dsd venv: `curl_cffi`, `playwright`.

## How to apply (on Kyle's PC, PowerShell)
    powershell -ExecutionPolicy Bypass -File "<this folder>\apply-fix.ps1"
It backs up `watcher.py` (`watcher.py.bak-<stamp>`), installs the module and packages,
patches, then runs `watcher.py check`. Expected last line: `14 of 14 homes read`.
The scheduled task is unchanged. Its next run resets the fail counters and the
"cannot read" flags in `state.json` on its own (a successful read always does).

## How to verify later
    C:\Users\Kyle\.claude\mcp-servers\gmail-dsd\.venv\Scripts\python.exe C:\Users\Kyle\.claude\tools\mls-watcher\watcher.py check
    Get-Content C:\Users\Kyle\.claude\tools\mls-watcher\watcher.log -Tail 20
`via curl_cffi:chrome131` = the light path worked; `via chrome` = the browser fallback
was needed (fine, just slower).

## How to roll back
    Copy-Item watcher.py.bak-<stamp> watcher.py
    Remove-Item zfetch.py, cookies.json; Remove-Item -Recurse chrome-profile
The venv packages can stay.

## If it is still blocked
When both layers report a block (`ZILLOW Zillow blocked the browser too`), the block is
on the PC's IP address, not the client. Options, cheapest first:
1. Wait: the 2026-09-27 block cleared within about 10 hours; the watcher recovers by
   itself on the next run and the Monday check-in confirms it.
2. Run the browser fallback headed (`headless=False` in `zfetch.py`) once and complete
   the "Press and Hold" check by hand; the cookies persist in `chrome-profile/`.
3. Add a second status source (Redfin's JSON API, or a paid listings API such as
   RapidAPI's Zillow endpoints, roughly $10 to $50 a month) as an automatic fallback.
Kyle accepted the Zillow Terms of Use risk in writing on 2026-09-26; this fix keeps the
same tiny volume (one page per home, three times a day).
