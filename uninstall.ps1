<#
.SYNOPSIS
    AgentDiskGuard 卸载脚本：移除环境变量与计划任务；绝不删除任何数据目录。
#>
[CmdletBinding()]
param(
    [switch]$KeepPolicy
)

$ErrorActionPreference = "Continue"

Write-Host "==> 移除用户环境变量"
$names = @(
    "npm_config_cache", "npm_config_store_dir", "YARN_CACHE_FOLDER", "PIP_CACHE_DIR",
    "UV_CACHE_DIR", "XDG_CACHE_HOME", "CARGO_HOME", "RUSTUP_HOME", "GRADLE_USER_HOME",
    "GOPATH", "GOMODCACHE", "GOCACHE", "DOCKER_CONFIG", "CODEX_HOME", "OLLAMA_MODELS",
    "HF_HOME", "CONDA_PKGS_DIRS", "NUGET_PACKAGES"
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

Write-Host "==> 移除计划任务"
Unregister-ScheduledTask -TaskName "AgentDiskGuard Monitor" -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "  OK 计划任务已移除（若存在）"

if (-not $KeepPolicy) {
    $policy = Join-Path $env:USERPROFILE ".agent-disk-guard\policy.yaml"
    if (Test-Path $policy) {
        Remove-Item $policy -Force
        Write-Host "  OK 已删除策略 $policy（数据目录 journal/日志保留）"
    }
}

Write-Host ""
Write-Host "卸载完成。" -ForegroundColor Green
Write-Host "注意："
Write-Host "  - 已迁移的 Junction 仍然有效（数据在 D 盘）。如需还原请用:"
Write-Host "      agent-disk-guard rollback <原目录> --yes"
Write-Host "  - D:\AgentCache 下的数据未删除，确认不再需要后可手动清理。"
