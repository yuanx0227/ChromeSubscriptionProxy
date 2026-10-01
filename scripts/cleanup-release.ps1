#Requires -Version 7.0
<#
Preview: pwsh -NoLogo -NoProfile -File .\scripts\cleanup-release.ps1
Delete:  pwsh -NoLogo -NoProfile -File .\scripts\cleanup-release.ps1 -Execute
Does not create backups. Never deletes current extension, signing keys or source.
#>
[CmdletBinding()]
param([switch]$Execute)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$manifestPath = Join-Path $projectRoot 'extension\public\manifest.json'
$installedManifestPath = Join-Path $projectRoot 'dist\extension\manifest.json'
$signingKeyPath = Join-Path $projectRoot 'signing\qingkong.pem'

function Assert-LocalPath([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith($projectRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "路径不在项目内，拒绝处理：$full"
    }
    # Check every existing component, not only the final deletion target.
    $cursor = $full
    while ($true) {
        if (Test-Path -LiteralPath $cursor) {
            $entry = Get-Item -LiteralPath $cursor -Force
            if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "发现链接或重解析点，拒绝处理：$cursor"
            }
        }
        $parent = Split-Path -Path $cursor -Parent
        if (-not $parent -or $parent -eq $cursor) { break }
        $cursor = $parent
    }
    return $full
}

foreach ($required in @($manifestPath, $installedManifestPath, $signingKeyPath)) {
    [void](Assert-LocalPath $required)
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "缺少必须保留的文件，停止清理：$required"
    }
}
$sourceVersion = (Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json).version
$loadedVersion = (Get-Content -LiteralPath $installedManifestPath -Raw | ConvertFrom-Json).version
foreach ($version in @($sourceVersion, $loadedVersion)) {
    if ($version -notmatch '^\d+\.\d+\.\d+(?:\.\d+)?$') { throw '插件版本格式异常，停止清理。' }
    $packagePath = Join-Path $projectRoot "releases\qingkong-$version.crx"
    [void](Assert-LocalPath $packagePath)
    if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
        throw "未找到当前版本安装包，停止清理：$packagePath"
    }
}
# If source/build differ, keep both releases. Never delete a newer package.
$highestCurrentVersion = @([version]$sourceVersion, [version]$loadedVersion) | Sort-Object -Descending | Select-Object -First 1
$keepVersions = @($sourceVersion, $loadedVersion)
$candidates = [Collections.Generic.List[string]]::new()
foreach ($relative in @('work', 'dist\extension.crx', 'server\__pycache__', 'scripts\__pycache__', 'checks\__pycache__')) {
    $path = Assert-LocalPath (Join-Path $projectRoot $relative)
    if (Test-Path -LiteralPath $path) { $candidates.Add($path) }
}
$releaseDir = Assert-LocalPath (Join-Path $projectRoot 'releases')
foreach ($file in Get-ChildItem -LiteralPath $releaseDir -File -Force) {
    if ($file.Name -match '^qingkong-(\d+\.\d+\.\d+(?:\.\d+)?)\.crx$') {
        $packageVersion = $Matches[1]
        if ($packageVersion -notin $keepVersions -and [version]$packageVersion -lt $highestCurrentVersion) {
            $candidates.Add((Assert-LocalPath $file.FullName))
        }
    }
}
# Only these known obsolete screenshots; keep current v3 previews and logo originals.
foreach ($name in @('popup.png', 'settings.png', 'popup-v2.png', 'settings-v2.png', 'settings-v2-empty.png', 'settings-v2-mobile.png', 'settings-v2-rules.png')) {
    $path = Assert-LocalPath (Join-Path $projectRoot "docs\screenshots\$name")
    if (Test-Path -LiteralPath $path) { $candidates.Add($path) }
}

if ($candidates.Count -eq 0) {
    Write-Host '没有需要清理的发布残留。'
    exit 0
}

# Do not remove any project test profile while a browser/helper may still own it.
$processes = Get-CimInstance Win32_Process
$unreadable = @($processes | Where-Object {
    $_.Name -in @('chrome.exe', 'node.exe', 'python.exe', 'pythonw.exe') -and -not $_.CommandLine
})
if ($unreadable.Count -gt 0) {
    throw '无法读取部分浏览器/Node/Python 进程的命令行。请关闭这些进程，或在有权读取它们的 PowerShell 7 中重试。'
}
$inUse = @($processes | Where-Object {
    $_.ProcessId -ne $PID -and $_.CommandLine -and (
        $_.CommandLine.Replace('/', '\').IndexOf(($projectRoot + '\work'), [StringComparison]::OrdinalIgnoreCase) -ge 0
    )
})
if ($inUse.Count -gt 0) {
    $inUse | Select-Object ProcessId, Name | Format-Table | Out-Host
    throw '项目临时目录仍被进程使用。请结束相关测试进程后重试；脚本不会强制结束进程。'
}

$plan = foreach ($path in $candidates) {
    $item = Get-Item -LiteralPath (Assert-LocalPath $path) -Force
    if ($item.PSIsContainer) {
        $entries = @(Get-ChildItem -LiteralPath $path -Recurse -Force)
        if ($entries | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) {
            throw "目录中存在链接或重解析点，停止清理：$path"
        }
        $bytes = ($entries | Where-Object { -not $_.PSIsContainer } | Measure-Object -Property Length -Sum).Sum
    } else { $bytes = $item.Length }
    [pscustomobject]@{ Path = $path; Bytes = [long]$bytes; MiB = [math]::Round($bytes / 1MB, 2) }
}

Write-Host "项目：$projectRoot"
Write-Host "保留版本：$($keepVersions | Select-Object -Unique)"
Write-Host '保留：dist\extension、signing、源码、文档、依赖、Logo 和当前安装包。'
Write-Host '待删除：work 下的全部临时脚本、结果、测试配置，以及下表中的旧发布文件。'
$plan | Select-Object Path, MiB | Format-Table -AutoSize | Out-Host
$totalBytes = ($plan | Measure-Object -Property Bytes -Sum).Sum
Write-Host ("共 {0} 项，约 {1:N2} MiB。" -f $plan.Count, ($totalBytes / 1MB))

if (-not $Execute) {
    Write-Host '当前为预览，没有删除任何文件。确认清单后加 -Execute 执行。'
    exit 0
}

$failed = [Collections.Generic.List[string]]::new()
$removedBytes = 0L
foreach ($target in $plan) {
    try {
        $path = Assert-LocalPath $target.Path
        if (-not (Test-Path -LiteralPath $path)) { continue }
        # Recheck links immediately before deleting, then use one native shell end-to-end.
        $item = Get-Item -LiteralPath $path -Force
        if ($item.PSIsContainer -and (Get-ChildItem -LiteralPath $path -Recurse -Force -Attributes ReparsePoint)) {
            throw '删除前发现目录链接，跳过此项。'
        }
        Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop
        if (Test-Path -LiteralPath $path) { throw '删除后目标仍然存在。' }
        $removedBytes += $target.Bytes
    } catch {
        $failed.Add($target.Path)
        Write-Warning "未完成：$($target.Path)；$($_.Exception.Message)"
    }
}
Write-Host ("清理完成 {0}/{1} 项，约 {2:N2} MiB。未创建备份。" -f ($plan.Count - $failed.Count), $plan.Count, ($removedBytes / 1MB))
if ($failed.Count -gt 0) { exit 1 }
