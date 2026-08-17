# GeoTeacher — install/deploy helper (DSH agent preset)
# Copies this repository's preset/ into DSH_HOME/.agent-presets/geo-teacher
# so DeepSeek Harness can mount it. Then follow README quick start.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/install.ps1 [-DSHHome C:\Users\<you>\.dsh]
param(
  [string]$DSHHome = "",
  [string]$PresetId = "geo-teacher"
)
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$PresetSrc = Join-Path $RepoRoot "preset"
if (-not (Test-Path $PresetSrc)) { throw "preset/ not found under $RepoRoot" }

if ([string]::IsNullOrWhiteSpace($DSHHome)) {
  $DSHHome = $env:DSH_HOME
  if ([string]::IsNullOrWhiteSpace($DSHHome)) { $DSHHome = Join-Path $env:USERPROFILE ".dsh" }
}
$PresetDst = Join-Path $DSHHome ".agent-presets\$PresetId"
New-Item -ItemType Directory -Force -Path $PresetDst | Out-Null
Copy-Item -Recurse -Force -Path (Join-Path $PresetSrc "*") -Destination $PresetDst
Write-Host "[geo-teacher] preset copied to $PresetDst"

Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Edit $PresetDst\agent.cordis.yml : replace <KB_ROOT>, <WORKSPACE>, <DSH_HOME> with your environment"
Write-Host "  2. Configure a vision provider route + API key in DSH settings.yaml (see config.example.yaml / DEPENDENCIES.md)"
Write-Host "  3. Restart DSH, then open a new geo-teacher session"
Write-Host "  4. Sanity: node scripts/geo-verify.mjs --source"
