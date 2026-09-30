"""zfetch: resilient Zillow page reads for the DSD MLS watcher (added 2026-09-30).

Why this exists
  Zillow sits behind PerimeterX (HUMAN) bot protection. A plain Python HTTP client
  presents a TLS fingerprint that does not match its Chrome User-Agent, and after a
  while every request gets "403 Forbidden" (seen 2026-09-27 and all day 2026-09-29,
  which is what made the watcher email "cannot read" for every home).

What it does, per page, in order
  1. curl_cffi with a real Chrome TLS/HTTP2 fingerprint, a cookie jar kept between runs
     (cookies.json) and a one-time homepage warm-up, so the visit looks like a
     returning browser.
  2. On 403 or a bot-check page: wait about a minute, drop the cookies, switch to a
     different browser fingerprint, try once more.
  3. Still blocked: open the page in the PC's real Google Chrome (Playwright, headless,
     its own profile folder chrome-profile/) and read the same listing JSON from the DOM.
  4. Still blocked: raise Blocked. The watcher then logs READ FAIL exactly as before
     (Kyle is emailed after 3 failed runs in a row; unchanged).

Everything is optional. With curl_cffi missing it falls back to httpx with full browser
headers; with Playwright or Chrome missing, step 3 is skipped. On first use it tries to
install curl_cffi into the venv (logged as SETUP lines).

Within one run, a block is remembered: once plain requests are blocked, later pages go
straight to the browser; once the browser is blocked too, later pages fail fast. So a
blocked run costs about 2 extra minutes, not 14 x 2 minutes.

Use from watcher.py
    import zfetch
    zfetch.log_to(log)                       # write SETUP/ZILLOW lines to watcher.log
    r = zfetch.get(url)                      # .status_code, .text, .url, .json(), .via
    r = zfetch.get(lookup_url, params={...}) # plain JSON calls take the same path
"""
import json, os, random, re, subprocess, sys, time
from urllib.parse import urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))
COOKIES = os.path.join(HERE, "cookies.json")
PROFILE = os.path.join(HERE, "chrome-profile")
HOME = "https://www.zillow.com/"
RETRY_WAIT = (45, 75)            # seconds before the one retry after a block
# Fingerprints to rotate through, most common first. Only the ones the installed
# curl_cffi knows are used; anything missing is skipped.
PREFERRED = ["chrome131", "chrome124", "chrome", "edge101", "safari180", "firefox133"]
# Words that appear only on Zillow's bot-check page (never on a listing page).
BLOCK_RE = re.compile(r"px-captcha|Press &amp; Hold|Press & Hold|Access to this page has been denied", re.I)
# httpx fallback only (no fingerprint control): send the full header set a browser sends.
FALLBACK_HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"),
    "Accept": ("text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,"
               "image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"),
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1", "Upgrade-Insecure-Requests": "1",
}

_log = print


def log_to(fn):
    """Route this module's log lines through the caller's logger (watcher.log)."""
    global _log
    _log = fn


class Blocked(RuntimeError):
    """Every layer failed. The message is the plain reason for the watcher log."""


class Result:
    """The subset of an httpx response the watcher uses."""
    def __init__(self, status_code, text, url, via):
        self.status_code, self.text, self.url, self.via = status_code, text, url, via

    def json(self):
        return json.loads(self.text)


# Per-process memory so one blocked run stays short (see module docstring).
_mem = {"http_blocked": {}, "browser_blocked": False, "browser_unavailable": False,
        "target_i": 0, "last_via": None}


def last_via():
    """Which layer produced the last successful read ('curl_cffi:chrome131', 'chrome', 'httpx')."""
    return _mem["last_via"]


# ---------------------------------------------------------------- curl_cffi setup
def _pip_python():
    exe = sys.executable
    if os.name == "nt" and os.path.basename(exe).lower() == "pythonw.exe":
        cand = os.path.join(os.path.dirname(exe), "python.exe")
        if os.path.exists(cand):
            return cand
    return exe


def _import_curl():
    try:
        from curl_cffi import requests as cr
        return cr
    except Exception:
        return None


def ensure_curl_cffi():
    """Import curl_cffi, installing it into this venv on first use. None = unavailable."""
    cr = _import_curl()
    if cr or _mem.get("curl_install_tried"):
        return cr
    _mem["curl_install_tried"] = True
    _log("SETUP curl_cffi missing; installing it into this venv (one time)")
    try:
        flags = 0x08000000 if os.name == "nt" else 0          # CREATE_NO_WINDOW under pythonw
        subprocess.run([_pip_python(), "-m", "pip", "install", "--quiet", "curl_cffi"],
                       timeout=600, check=True, stdout=subprocess.DEVNULL,
                       stderr=subprocess.STDOUT, creationflags=flags)
    except Exception as ex:
        _log(f"SETUP curl_cffi install failed: {type(ex).__name__}: {ex} (using httpx instead)")
        return None
    cr = _import_curl()
    _log("SETUP curl_cffi installed" if cr else "SETUP curl_cffi still missing after install (using httpx instead)")
    return cr


def _targets():
    try:
        from curl_cffi.requests.impersonate import BrowserType
        have = {b.value for b in BrowserType}
    except Exception:
        return ["chrome"]
    return [t for t in PREFERRED if t in have] or ["chrome"]


# ---------------------------------------------------------------- cookie jar
def _load_cookies(session):
    """Returns True when saved cookies were loaded (a returning visitor)."""
    try:
        with open(COOKIES, encoding="utf-8") as f:
            saved = json.load(f)
        for c in saved:
            session.cookies.set(c["name"], c["value"], domain=c.get("domain", ""), path=c.get("path", "/"))
        return bool(saved)
    except Exception:
        return False


def _save_cookies(session):
    try:
        rows = [{"name": c.name, "value": c.value, "domain": c.domain, "path": c.path}
                for c in session.cookies.jar]
        with open(COOKIES, "w", encoding="utf-8") as f:
            json.dump(rows, f)
    except Exception:
        pass


def _clear_cookies():
    try:
        os.remove(COOKIES)
    except OSError:
        pass


# ---------------------------------------------------------------- layer 1: HTTP
def _blocked(r):
    return r.status_code in (403, 429) or bool(BLOCK_RE.search(r.text[:300000]))


def _httpx_request(url, params):
    import httpx
    r = httpx.get(url, params=params, headers=FALLBACK_HEADERS, follow_redirects=True, timeout=40)
    return Result(r.status_code, r.text, str(r.url), "httpx")


def _curl_request(cr, url, params):
    targets = _targets()
    target = targets[_mem["target_i"] % len(targets)]
    s = cr.Session(impersonate=target, timeout=40)
    returning = _load_cookies(s)
    page_read = params is None
    if page_read and not returning:
        try:                                    # first visit: land on the homepage first
            s.get(HOME, allow_redirects=True)
            time.sleep(random.uniform(1.5, 3.5))
        except Exception:
            pass
    headers = {"Referer": HOME} if page_read else {}
    r = s.get(url, params=params, headers=headers, allow_redirects=True)
    _save_cookies(s)
    return Result(r.status_code, r.text, str(r.url), f"curl_cffi:{target}")


def _http_layer(url, params):
    """One request, plus one retry after a wait when blocked. None = blocked."""
    cr = ensure_curl_cffi()
    host = urlsplit(url).netloc
    reason = None
    for attempt in range(2):
        if attempt:
            wait = random.uniform(*RETRY_WAIT)
            _log(f"ZILLOW {reason}; waiting {wait:.0f}s, then retrying with another browser fingerprint")
            time.sleep(wait)
            _mem["target_i"] += 1
            _clear_cookies()
        try:
            r = _curl_request(cr, url, params) if cr else _httpx_request(url, params)
        except Exception as ex:
            if attempt:
                raise                           # a network problem, not a block: report it as is
            _log(f"ZILLOW request error {type(ex).__name__}: {ex}; retrying in 10s")
            time.sleep(10)
            try:
                r = _curl_request(cr, url, params) if cr else _httpx_request(url, params)
            except Exception:
                raise
        if not _blocked(r):
            _mem["last_via"] = r.via
            return r
        reason = f"Zillow answered {r.status_code}" + (" with a bot-check page" if r.status_code == 200 else "")
    _mem["http_blocked"][host] = reason
    _log(f"ZILLOW plain requests blocked for the rest of this run ({reason})")
    return None


# ---------------------------------------------------------------- layer 2: real Chrome
def _browser_layer(url):
    """Load the page in Google Chrome through Playwright. None = unavailable or blocked."""
    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        _mem["browser_unavailable"] = "playwright not installed (pip install playwright)"
        _log(f"ZILLOW browser fallback unavailable: {_mem['browser_unavailable']}")
        return None
    _log("ZILLOW opening the page in Chrome instead (browser fallback)")
    try:
        with sync_playwright() as p:
            ctx, err = None, None
            for channel in ("chrome", "msedge", None):        # installed Chrome, Edge, bundled
                try:
                    kw = dict(headless=True, viewport={"width": 1366, "height": 900}, locale="en-US",
                              args=["--disable-blink-features=AutomationControlled"])
                    if channel:
                        kw["channel"] = channel
                    ctx = p.chromium.launch_persistent_context(PROFILE, **kw)
                    break
                except Exception as ex:
                    err = f"{type(ex).__name__}: {str(ex).splitlines()[0][:160]}"
            if ctx is None:
                _mem["browser_unavailable"] = f"no browser could start ({err})"
                _log(f"ZILLOW browser fallback unavailable: {_mem['browser_unavailable']}")
                return None
            try:
                page = ctx.new_page()
                resp = page.goto(url, wait_until="domcontentloaded", timeout=60000)
                try:
                    page.wait_for_selector("script#__NEXT_DATA__", state="attached", timeout=20000)
                except Exception:
                    time.sleep(3)
                r = Result(resp.status if resp else 0, page.content(), page.url, "chrome")
            finally:
                ctx.close()
    except Exception as ex:
        _mem["browser_unavailable"] = f"{type(ex).__name__}: {str(ex).splitlines()[0][:160]}"
        _log(f"ZILLOW browser fallback failed: {_mem['browser_unavailable']}")
        return None
    if _blocked(r):
        _mem["browser_blocked"] = f"Zillow blocked the browser too (answered {r.status_code})"
        _log("ZILLOW " + _mem["browser_blocked"])
        return None
    _mem["last_via"] = "chrome"
    return r


# ---------------------------------------------------------------- public entry point
def get(url, params=None):
    """Drop-in for httpx.get(url, params=...). Raises Blocked when every layer fails."""
    host = urlsplit(url).netloc
    http_reason = _mem["http_blocked"].get(host)
    if not http_reason:
        r = _http_layer(url, params)
        if r is not None:
            return r
        http_reason = _mem["http_blocked"].get(host, "blocked")
    if params is None and not (_mem["browser_blocked"] or _mem["browser_unavailable"]):
        r = _browser_layer(url)
        if r is not None:
            return r
    extra = _mem["browser_blocked"] or _mem["browser_unavailable"]
    raise Blocked(f"{http_reason}; browser fallback: {extra or 'not tried'}")
