# Install dsh-goal-loop into the current DSH profile.
#
# Idempotent: re-running links the same junction and never appends the bundle
# entry twice. Nothing is copied -- the profile points at this working tree, so
# edits here take effect on the next profile reload.
[CmdletBinding()]
param(
    [string]$Profile = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop')
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$pluginName = 'dsh-goal-loop'
$manifestPath = Join-Path $Profile 'package.json'
$linkPath = Join-Path $Profile "node_modules\$pluginName"

if (-not (Test-Path $manifestPath)) { throw "profile manifest not found: $manifestPath" }

# 1) junction: the profile resolves bundle names from its own node_modules.
if (Test-Path $linkPath) {
    $existing = (Get-Item $linkPath).Target
    Write-Host "[ok] link exists: $linkPath -> $existing"
} else {
    New-Item -ItemType Directory -Path (Split-Path -Parent $linkPath) -Force | Out-Null
    New-Item -ItemType Junction -Path $linkPath -Target $here | Out-Null
    Write-Host "[new] link created: $linkPath -> $here"
}

# 2) bundle layer: append the name to dsh.profile.bundles (order = precedence,
#    so it goes last and never disturbs existing layers).
#    Read with an explicit BOM strip: this file is also parsed by JSON.parse on
#    the Node side, and a UTF-8 BOM there is "Unexpected token".
$rawManifest = (Get-Content $manifestPath -Raw).TrimStart([char]0xFEFF)
$manifest = $rawManifest | ConvertFrom-Json
if ($null -eq $manifest.dsh) { $manifest | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) }
if ($null -eq $manifest.dsh.profile) { $manifest.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{ bundles = @() }) }
$bundles = @($manifest.dsh.profile.bundles)
if ($bundles -contains $pluginName) {
    Write-Host "[ok] bundles already contains $pluginName"
} else {
    Copy-Item $manifestPath "$manifestPath.bak-goal" -Force
    $manifest.dsh.profile.bundles = @($bundles + $pluginName)
    #    Set-Content -Encoding UTF8 emits a BOM on PowerShell 5.1, which breaks
    #    every JSON.parse of this manifest. Write UTF-8 without BOM explicitly.
    $json = $manifest | ConvertTo-Json -Depth 12
    [System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "[new] appended $pluginName to dsh.profile.bundles (backup: package.json.bak-goal)"
}

Write-Host ""
Write-Host "Next: the profile reloads on save. Expect goal-loop in the skill catalog"
Write-Host "and goal_define / goal_check / goal_review / goal_verdict / goal_status in the tool list."
Write-Host "If not visible, quit and reopen the client once."
