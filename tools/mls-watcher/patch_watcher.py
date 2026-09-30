"""Targeted patch: make the DSD MLS watcher read Zillow through zfetch (2026-09-30).

Usage:  python patch_watcher.py  C:\\Users\\Kyle\\.claude\\tools\\mls-watcher\\watcher.py

Edits only these spots in watcher.py, each found by an exact anchor:
  1. import line: adds `import zfetch` next to `import dsd_store`
  2. log(): hooks zfetch's log lines into watcher.log
  3. zillow_get(): one line, now calls zfetch.get()
  4. resolve(): the address-lookup call goes through zfetch too
  5. adds a read-only `check` command (reads every home, prints, changes nothing, sends nothing)
  6. docstring: lists the new command
If any anchor is missing, or the patch is already applied, the file is left untouched
and the reason is printed. Exit code 0 = patched (or already patched), 1 = not patched.
Line endings and encoding are preserved.
"""
import re, sys

ZILLOW_GET = '''def zillow_get(url):
    # 2026-09-30: real-Chrome TLS fingerprint, retry after a wait, then the PC's own
    # Chrome as a fallback. See zfetch.py. Raises zfetch.Blocked with the plain reason.
    return zfetch.get(url)

'''

CMD_CHECK = '''def cmd_check():
    """Read every active home once and print the result. Changes nothing, sends nothing.
    Run it after a repair to prove Zillow reads work: exit code 0 = every home read."""
    homes = [h for h in load(WATCHLIST, []) if h.get("active", True)]
    bad = 0
    for i, h in enumerate(homes):
        if i:
            time.sleep(random.uniform(3, 7))
        try:
            info = read_listing(h["url"], h["zpid"])
            print(f"OK    {h['address']:48} {info['status']:16} via {zfetch.last_via()}")
        except Exception as ex:
            bad += 1
            print(f"FAIL  {h['address']:48} {ex}")
    print(f"{len(homes) - bad} of {len(homes)} homes read")
    log(f"CHECK: {len(homes) - bad} of {len(homes)} homes read (nothing saved, nothing sent)")
    sys.exit(1 if bad else 0)


'''


def apply(text):
    edits = [
        ("import zfetch next to dsd_store",
         r"^(import dsd_store\b[^\n]*\n)",
         r"\1import zfetch                                      # resilient Zillow reads (2026-09-30)\n"),
        ("log hookup before load()",
         r"^(def load\(path, default\):)",
         r"zfetch.log_to(log)      # zfetch writes its SETUP/ZILLOW lines to watcher.log (2026-09-30)\n\n\n\1"),
        ("zillow_get body",
         r"^def zillow_get\(url\):\n(?:[ \t]+[^\n]*\n)+\n",
         ZILLOW_GET),
        ("resolve() lookup call",
         r'r = httpx\.get\("https://www\.zillowstatic\.com/autocomplete/v3/suggestions",\s*\n\s*params=\{"q": address\}, headers=\{"User-Agent": UA\}, timeout=20\)',
         'r = zfetch.get("https://www.zillowstatic.com/autocomplete/v3/suggestions", params={"q": address})'),
        ("command choices",
         r'choices=\["run", "add", "remove", "list", "heartbeat"\]',
         'choices=["run", "add", "remove", "list", "heartbeat", "check"]'),
        ("command dispatch",
         r'(        elif a\.cmd == "heartbeat":\n            cmd_run\(force_heartbeat=True\)\n)',
         r'\1        elif a.cmd == "check":\n            cmd_check()\n'),
        ("cmd_check before main()",
         r"^(def main\(\):)",
         CMD_CHECK.replace("\\", "\\\\") + r"\1"),
    ]
    optional = [
        ("docstring command list",
         r"^(  watcher\.py heartbeat[^\n]*\n)",
         r"\1  watcher.py check          (read every home once, print, save and send nothing)\n"),
    ]
    for name, pat, rep in edits:
        n = len(re.findall(pat, text, flags=re.M))
        if n != 1:
            return None, f"anchor '{name}' found {n} times (expected 1); nothing changed"
    for name, pat, rep in edits:
        text = re.sub(pat, rep, text, count=1, flags=re.M)
    for name, pat, rep in optional:
        if len(re.findall(pat, text, flags=re.M)) == 1:
            text = re.sub(pat, rep, text, count=1, flags=re.M)
        else:
            print(f"note: optional edit '{name}' skipped (anchor not found)")
    return text, "patched"


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    path = sys.argv[1]
    with open(path, "rb") as f:
        raw = f.read()
    crlf = b"\r\n" in raw
    text = raw.decode("utf-8").replace("\r\n", "\n")
    if "import zfetch" in text:
        print("already patched; nothing changed")
        sys.exit(0)
    new, msg = apply(text)
    if new is None:
        print("NOT PATCHED: " + msg)
        sys.exit(1)
    out = new.replace("\n", "\r\n") if crlf else new
    with open(path, "wb") as f:
        f.write(out.encode("utf-8"))
    print(f"{msg}: {path}")


if __name__ == "__main__":
    main()
