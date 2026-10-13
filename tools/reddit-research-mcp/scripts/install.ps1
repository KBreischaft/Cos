<#
.SYNOPSIS
  Installs the Reddit Research MCP server, runs the live smoke test, and registers
  it with Claude Code and Claude Desktop.

.DESCRIPTION
  Safe to re-run. Backs up claude_desktop_config.json before changing it and only
  touches the "reddit-research" entry. Works on Windows PowerShell 5.1 and PowerShell 7.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\tools\reddit-research-mcp\scripts\install.ps1
#>
[CmdletBinding()]
param(
  [string]$DesktopConfigPath = $(if ($env:APPDATA) { Join-Path $env:APPDATA 'Claude\claude_desktop_config.json' } else { '' }),
  [switch]$SkipSmoke,
  [switch]$SkipClaudeCode,
  [switch]$SkipDesktop
)
$ErrorActionPreference = 'Stop'
$ServerName = 'reddit-research'
$Root = Split-Path -Parent $PSScriptRoot
$Entry = Join-Path (Join-Path $Root 'src') 'index.js'

function Step($msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "   OK  $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "   !!  $msg" -ForegroundColor Yellow }

Step 'Checking Node.js'
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { throw 'Node.js 18+ is required. Install the LTS from https://nodejs.org/en/download and re-run.' }
$Node = $nodeCmd.Source
$major = [int]((& $Node --version).TrimStart('v').Split('.')[0])
if ($major -lt 18) { throw "Node.js 18+ is required; found $(& $Node --version)." }
Ok "node $(& $Node --version) at $Node"

Step 'Installing dependencies'
Push-Location $Root
try {
  & npm install --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
} finally { Pop-Location }
Ok 'dependencies installed'

$smokeOk = $null
if (-not $SkipSmoke) {
  Step 'Live smoke test against the Reddit archives (about 1 minute)'
  & $Node (Join-Path $PSScriptRoot 'smoke-live.mjs')
  $smokeOk = ($LASTEXITCODE -eq 0)
  if ($smokeOk) { Ok 'all live checks passed' } else { Warn 'some live checks failed (see FAIL lines above). Registering anyway; the server falls back between archives.' }
}

if (-not $SkipClaudeCode) {
  Step 'Registering with Claude Code (user scope)'
  $claude = Get-Command claude -ErrorAction SilentlyContinue
  if (-not $claude) {
    Warn 'claude CLI not found; skipped.'
  } else {
    & $claude.Source mcp remove --scope user $ServerName 2>$null | Out-Null
    & $claude.Source mcp add --scope user --transport stdio $ServerName '--' $Node $Entry
    if ($LASTEXITCODE -ne 0) { throw 'claude mcp add failed.' }
    Ok "added '$ServerName' to Claude Code"
  }
}

if (-not $SkipDesktop) {
  Step 'Registering with Claude Desktop'
  if (-not $DesktopConfigPath -or -not (Test-Path (Split-Path -Parent $DesktopConfigPath))) {
    Warn 'Claude Desktop config folder not found; skipped.'
  } else {
    $config = [pscustomobject]@{}
    if (Test-Path $DesktopConfigPath) {
      $raw = Get-Content -Raw -Path $DesktopConfigPath
      if ($raw.Trim()) { $config = $raw | ConvertFrom-Json }
      $backup = "$DesktopConfigPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
      Copy-Item $DesktopConfigPath $backup
      Ok "backup: $backup"
    }
    if (-not ($config.PSObject.Properties.Name -contains 'mcpServers')) {
      $config | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{})
    }
    $entryObj = [pscustomobject]@{ command = $Node; args = @($Entry) }
    if ($config.mcpServers.PSObject.Properties.Name -contains $ServerName) {
      $config.mcpServers.$ServerName = $entryObj
    } else {
      $config.mcpServers | Add-Member -NotePropertyName $ServerName -NotePropertyValue $entryObj
    }
    $json = $config | ConvertTo-Json -Depth 50
    [System.IO.File]::WriteAllText($DesktopConfigPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    Ok "wrote '$ServerName' to $DesktopConfigPath. Fully quit and reopen Claude Desktop to load it."
  }
}

Write-Host ''
if ($smokeOk -eq $false) { Write-Host 'Installed, but the live smoke test had failures.' -ForegroundColor Yellow; exit 1 }
Write-Host 'Done.' -ForegroundColor Green
