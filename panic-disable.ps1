# 急诊停用：DSH 打不开时，双击这个（或在 PowerShell 里跑）
#
# 只用 PowerShell，不依赖 node —— 崩溃现场也能跑。
#   .\panic-disable.ps1          只报告会改什么，不动文件
#   .\panic-disable.ps1 -Apply   真改
#
# 做三件事：
#   1. 从 profile 的 dsh.profile.bundles 里去掉 dsh-goal-loop
#   2. 从 profile 的 dependencies 里去掉 dsh-goal-loop
#   3. 删掉 profile\node_modules\dsh-goal-loop 这个 junction
# 工作树一行不动，重新启用跑 install.ps1 即可。

param([switch]$Apply)

$ErrorActionPreference = 'Stop'
$profileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$manifestPath = Join-Path $profileDir 'package.json'
$linkPath = Join-Path $profileDir 'node_modules\dsh-goal-loop'
$name = 'dsh-goal-loop'

if (-not (Test-Path -LiteralPath $manifestPath)) {
    Write-Host "[fail] 找不到 $manifestPath" -ForegroundColor Red
    exit 1
}

$utf8 = New-Object System.Text.UTF8Encoding($false)
$raw = [System.IO.File]::ReadAllText($manifestPath, [System.Text.Encoding]::UTF8)
$raw = $raw.TrimStart([char]0xFEFF)
$manifest = $raw | ConvertFrom-Json

$bundles = @($manifest.dsh.profile.bundles)
$hasBundle = $bundles -contains $name
$hasDep = $null -ne $manifest.dependencies.PSObject.Properties[$name]
$hasLink = Test-Path -LiteralPath $linkPath

Write-Host "profile : $profileDir"
Write-Host "bundles : $($bundles.Count) 条，包含 $name = $hasBundle"
Write-Host "deps    : 包含 $name = $hasDep"
Write-Host "link    : 存在 = $hasLink"

if (-not ($hasBundle -or $hasDep -or $hasLink)) {
    Write-Host "已经是干净状态，什么都不用做。" -ForegroundColor Green
    exit 0
}

if (-not $Apply) {
    Write-Host ""
    Write-Host "以上是要改的东西。加 -Apply 才会真改：" -ForegroundColor Yellow
    Write-Host "  .\panic-disable.ps1 -Apply" -ForegroundColor Yellow
    exit 0
}

if ($hasBundle) {
    $kept = $bundles | Where-Object { $_ -ne $name }
    $manifest.dsh.profile.bundles = @($kept)
}
if ($hasDep) {
    $manifest.dependencies.PSObject.Properties.Remove($name)
}

$json = $manifest | ConvertTo-Json -Depth 32
[System.IO.File]::WriteAllText($manifestPath, $json + "`n", $utf8)

if ($hasLink) {
    # junction 用 cmd 的 rmdir，Remove-Item 对 junction 会去删目标内容
    cmd /c rmdir "$linkPath" 2>$null
}

$check = ([System.IO.File]::ReadAllText($manifestPath, [System.Text.Encoding]::UTF8)) | ConvertFrom-Json
Write-Host ""
Write-Host "[done] bundles 现在 $($check.dsh.profile.bundles.Count) 条，包含 $name = $($check.dsh.profile.bundles -contains $name)" -ForegroundColor Green
Write-Host "[done] link 还存在 = $(Test-Path -LiteralPath $linkPath)" -ForegroundColor Green
Write-Host "重新启用： cd 到插件目录，跑 .\install.ps1"
