# agent-bridge installer (Windows)
#
# Idempotent. Never overwrites an existing config. Links the skill into the
# skills directory so `git pull` keeps it current, and prints the MCP block
# instead of editing opencode.jsonc - that file is hand-maintained JSONC and a
# script rewriting it would eventually eat a comment.
#
#   pwsh -File scripts\install.ps1            # detect this host
#   pwsh -File scripts\install.ps1 -Host big-bro
[CmdletBinding()]
param(
  [string]$HostName,
  [string]$SkillsDir = (Join-Path $HOME ".opencode\skills"),
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$configDir = Join-Path $HOME ".agent-bridge"
$configPath = Join-Path $configDir "config.json"

if (-not $HostName) {
  $HostName = if ($env:COMPUTERNAME -match 'DESKTOP') { 'kyros-home' } else { 'big-bro' }
}
$example = Join-Path $repo "config\$HostName.example.json"
if (-not (Test-Path $example)) {
  throw "no example config for '$HostName' at $example (expected kyros-home or big-bro)"
}

Write-Host "agent-bridge -> $repo" -ForegroundColor Cyan
Write-Host "  host profile : $HostName"

# 1. config
New-Item -ItemType Directory -Force -Path $configDir | Out-Null
if ((Test-Path $configPath) -and -not $Force) {
  Write-Host "  config       : kept existing $configPath" -ForegroundColor Yellow
} else {
  Copy-Item $example $configPath -Force
  Write-Host "  config       : wrote $configPath" -ForegroundColor Green
}

# 2. skill
New-Item -ItemType Directory -Force -Path $SkillsDir | Out-Null
$link = Join-Path $SkillsDir "agent-bridge"
$target = Join-Path $repo "skill\agent-bridge"
if (Test-Path $link) { Remove-Item $link -Recurse -Force }
try {
  New-Item -ItemType Junction -Path $link -Target $target | Out-Null
  Write-Host "  skill        : linked $link -> $target" -ForegroundColor Green
} catch {
  Copy-Item $target $link -Recurse -Force
  Write-Host "  skill        : copied to $link (junction unavailable)" -ForegroundColor Yellow
}

# 3. MCP block
$bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
if (-not $bun) { $bun = "bun" }
$mcp = Join-Path $repo "src\mcp.ts"
Write-Host ""
Write-Host "Add this to opencode.jsonc under mcp.servers (no restart needed - mcp.servers" -ForegroundColor Cyan
Write-Host "re-resolves per list/connect). The skill link is the opposite: skills paths are" -ForegroundColor Cyan
Write-Host "a startup read, so a new server process is needed before it loads:" -ForegroundColor Cyan
Write-Host @"
    "agent-bridge": {
      "type": "local",
      "command": ["$($bun -replace '\\','/')", "run", "$($mcp -replace '\\','/')"],
      "environment": { "AGENT_BRIDGE_CONFIG": "$($configPath -replace '\\','/')" }
    }
"@

Write-Host ""
Write-Host "Verify:" -ForegroundColor Cyan
Write-Host "  cd `"$repo`"; bun test; bun run src/cli.ts hosts; bun run src/cli.ts ping $HostName"
