# Applies the 2026-09-30 Zillow-block fix to the DSD MLS watcher. Safe to run twice.
# What it does: backs up watcher.py, installs zfetch.py next to it, installs curl_cffi and
# playwright into the gmail-dsd venv, patches watcher.py (6 anchored edits, see
# patch_watcher.py), then runs `watcher.py check`, which reads every home once and
# changes nothing. Exit code 0 = every home read.
$ErrorActionPreference = "Stop"
$Src  = $PSScriptRoot
$Tool = Join-Path $env:USERPROFILE ".claude\tools\mls-watcher"
$Py   = Join-Path $env:USERPROFILE ".claude\mcp-servers\gmail-dsd\.venv\Scripts\python.exe"

foreach ($p in @($Tool, $Py, "$Src\zfetch.py", "$Src\patch_watcher.py")) {
    if (-not (Test-Path $p)) { throw "not found: $p" }
}
$stamp = Get-Date -Format "yyyy-MM-dd-HHmm"
Copy-Item "$Tool\watcher.py" "$Tool\watcher.py.bak-$stamp"
Write-Host "backup: $Tool\watcher.py.bak-$stamp"

Copy-Item "$Src\zfetch.py" "$Tool\zfetch.py" -Force
Write-Host "installed: $Tool\zfetch.py"

Write-Host "installing curl_cffi and playwright into the gmail-dsd venv..."
& $Py -m pip install --quiet --upgrade curl_cffi playwright
if ($LASTEXITCODE -ne 0) { throw "pip install failed" }

$chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
            "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
            "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ }
if (-not $chrome) {
    Write-Host "Google Chrome not found; downloading Playwright's Chromium for the browser fallback..."
    & $Py -m playwright install chromium
}

& $Py "$Src\patch_watcher.py" "$Tool\watcher.py"
if ($LASTEXITCODE -ne 0) { throw "patch not applied; watcher.py is unchanged (backup kept)" }

# keep the new runtime files out of git
$gi = "$Tool\.gitignore"
foreach ($line in @("cookies.json", "chrome-profile/", "watcher.py.bak-*")) {
    if (-not (Test-Path $gi) -or -not (Select-String -Path $gi -SimpleMatch $line -Quiet)) { Add-Content $gi $line }
}

Write-Host ""
Write-Host "reading every home once (nothing saved, nothing emailed)..."
& $Py "$Tool\watcher.py" check
$rc = $LASTEXITCODE
Write-Host ""
Write-Host "last log lines:"
Get-Content "$Tool\watcher.log" -Tail 8
if ($rc -ne 0) {
    Write-Host ""
    Write-Host "Some homes still could not be read. See README-FIX.md, section 'If it is still blocked'."
    exit $rc
}
Write-Host ""
Write-Host "All homes read. The scheduled task 'DSD MLS Watcher' keeps its 6 AM / noon / 7 PM Arizona times;"
Write-Host "its next run resets the fail counters and the 'cannot read' flags by itself."
