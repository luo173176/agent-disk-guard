<#
.SYNOPSIS
    AgentDiskGuard 卸载脚本：还原环境变量、移除计划任务；默认保留用户策略与所有数据目录。

.DESCRIPTION
    环境变量按 install.ps1 记录的 %USERPROFILE%\.agent-disk-guard\env-backup.json 逐项还原
    （安装前没设置的会被删除，安装前有值的会还原成原值），不是一律删除。
    没有备份文件时（旧版本安装或手工设置的变量）退回按变量名清理。
#>
[CmdletBinding()]
param(
    [switch]$RemovePolicy
)

$ErrorActionPreference = "Continue"

$dataDir = Join-Path $env:USERPROFILE ".agent-disk-guard"
$backupFile = Join-Path $dataDir "env-backup.json"

Write-Host "==> 还原用户环境变量"
$backup = $null
if (Test-Path $backupFile) {
    try { $backup = Get-Content $backupFile -Raw | ConvertFrom-Json } catch { $backup = $null }
}

if ($backup -and @($backup.PSObject.Properties).Count -gt 0) {
    foreach ($prop in $backup.PSObject.Properties) {
        $current = [Environment]::GetEnvironmentVariable($prop.Name, "User")
        $orig = $prop.Value
        if ($current -eq $orig) { continue }
        [Environment]::SetEnvironmentVariable($prop.Name, $orig, "User")
        if ($null -eq $orig) {
            Write-Host "  OK 已移除 $($prop.Name)（安装前未设置）"
        } else {
            Write-Host "  OK $($prop.Name) 还原为 $orig"
        }
    }
    Write-Host "  （备份文件保留在 $backupFile，确认无误后可手动删除）"
} else {
    Write-Host "  ! 未找到 $backupFile（旧版本安装），退回按变量名清理"
    $names = @(
        "npm_config_cache", "npm_config_store_dir", "YARN_CACHE_FOLDER", "PIP_CACHE_DIR",
        "UV_CACHE_DIR", "XDG_CACHE_HOME", "CARGO_HOME", "RUSTUP_HOME", "GRADLE_USER_HOME",
        "GOPATH", "GOMODCACHE", "GOCACHE", "DOCKER_CONFIG", "CODEX_HOME", "OLLAMA_MODELS",
        "HF_HOME", "CONDA_PKGS_DIRS", "NUGET_PACKAGES", "TMP", "TEMP"
    )
    foreach ($n in $names) {
        $old = [Environment]::GetEnvironmentVariable($n, "User")
        if ($null -ne $old) {
            [Environment]::SetEnvironmentVariable($n, $null, "User")
            Write-Host "  OK 已移除 $n"
        }
    }
    # MAVEN_OPTS 去掉 maven.repo.local，保留其他参数
    $maven = [Environment]::GetEnvironmentVariable("MAVEN_OPTS", "User")
    if ($maven) {
        $kept = ($maven -split "\s+") | Where-Object { $_ -and $_ -notmatch "^-Dmaven\.repo\.local=" }
        [Environment]::SetEnvironmentVariable("MAVEN_OPTS", ($kept -join " "), "User")
        Write-Host "  OK 已清理 MAVEN_OPTS"
    }
}

Write-Host "==> 移除计划任务"
Unregister-ScheduledTask -TaskName "AgentDiskGuard Monitor" -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "  OK 计划任务已移除（若存在）"

$policy = Join-Path $dataDir "policy.yaml"
if ($RemovePolicy) {
    if (Test-Path $policy) {
        $bak = "$policy.uninstalled.bak"
        Copy-Item $policy $bak -Force
        Remove-Item $policy -Force
        Write-Host "  OK 已删除策略 $policy（备份保留在 $bak）"
    }
} else {
    Write-Host "  OK 策略文件保留：$policy（要一并删除请加 -RemovePolicy）"
}

Write-Host ""
Write-Host "卸载完成。" -ForegroundColor Green
Write-Host "注意："
Write-Host "  - 已迁移的 Junction 仍然有效（数据在 D 盘）。如需还原请用:"
Write-Host "      agent-disk-guard rollback <原目录> --yes"
Write-Host "  - 重定向根目录下的数据未删除，确认不再需要后可手动清理。"
