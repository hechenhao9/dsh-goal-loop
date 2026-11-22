# Remove dsh-goal-loop from the current DSH profile.
# Keeps the working tree and every .goal/ ledger on disk.
[CmdletBinding()]
param(
    [string]$Profile = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop')
)

$ErrorActionPreference = 'Stop'
$pluginName = 'dsh-goal-loop'
$manifestPath = Join-Path $Profile 'package.json'
$linkPath = Join-Path $Profile "node_modules\$pluginName"

if (Test-Path $linkPath) {
    $item = Get-Item $linkPath
    if ($item.LinkType -eq 'Junction') { $item.Delete() } else { Remove-Item $linkPath -Recurse -Force }
    Write-Host "[gone] link removed: $linkPath"
}

if (Test-Path $manifestPath) {
    $manifest = (Get-Content $manifestPath -Raw).TrimStart([char]0xFEFF) | ConvertFrom-Json
    $bundles = @($manifest.dsh.profile.bundles)
    if ($bundles -contains $pluginName) {
        Copy-Item $manifestPath "$manifestPath.bak-goal-remove" -Force
        $manifest.dsh.profile.bundles = @($bundles | Where-Object { $_ -ne $pluginName })
        # No BOM: Node parses this manifest with JSON.parse.
        $json = $manifest | ConvertTo-Json -Depth 12
        [System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "[gone] $pluginName removed from dsh.profile.bundles"
    } else {
        Write-Host "[ok] bundles does not contain $pluginName"
    }

    # Drop the dependency record too: leaving it behind would keep a card for a
    # plugin whose files are gone, and pnpm would try to resolve the dead link.
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if ($node) {
        $here = Split-Path -Parent $MyInvocation.MyCommand.Path
        & $node (Join-Path $here 'scripts-link-dep.mjs') $manifestPath $here remove
    }
}

Write-Host "Restart the client to unload the plugin. .goal/ ledgers are untouched."
