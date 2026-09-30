<#
.SYNOPSIS
    AgentDiskGuard 安装脚本（Windows / PowerShell 5.1+）。

.DESCRIPTION
    做四件事，全部幂等、可重复执行：
      1. 创建重定向根目录及子目录（D:\AgentCache\...）
      2. 复制默认策略到 %USERPROFILE%\.agent-disk-guard\policy.yaml（已存在则跳过，-ForcePolicy 覆盖）
      3. 写入用户环境变量（npm_config_cache / PIP_CACHE_DIR / CARGO_HOME / ...）
      4. （可选）注册每 15 分钟一次的磁盘监控计划任务
    不做任何目录迁移——迁移请用 agent-disk-guard migrate（默认 dry-run，需 --yes 确认）。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install.ps1
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -RedirectRoot "E:\AgentCache" -InstallScheduledTask
#>
[CmdletBinding()]
param(
    [string]$RedirectRoot = "D:\AgentCache",
    [switch]$ForcePolicy,
    [switch]$InstallScheduledTask,
    [switch]$RedirectTemp,
    [string]$CliPath = ""
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  OK $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "  !! $msg" -ForegroundColor Yellow }

# --- 0. 前置检查 ------------------------------------------------------------
Write-Step "前置检查"
if (-not $env:USERNAME) { throw "无法确定当前用户" }
$redirectDrive = ($RedirectRoot.TrimEnd('\'))[0]
if ($redirectDrive -ieq "C") {
    throw "RedirectRoot 不能在 C 盘上（当前: $RedirectRoot）。请指定其他盘符，如 D:\AgentCache"
}
Write-Ok "用户: $env:USERNAME，重定向根: $RedirectRoot"

# --- 1. 创建目录 ------------------------------------------------------------
Write-Step "创建重定向目录结构"
$subdirs = @(
    "", "npm-cache", "pnpm-store", "yarn-cache", "pip", "uv-cache", "xdg-cache",
    "cargo", "rustup", "gradle", "m2\repository", "docker", "codex",
    "ollama\models", "huggingface", "conda\pkgs", "nuget", "go\pkg\mod",
    "go-build", "temp", "mirror"
)
foreach ($s in $subdirs) {
    $dir = if ($s) { Join-Path $RedirectRoot $s } else { $RedirectRoot }
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        Write-Ok "创建 $dir"
    }
}

# --- 2. 用户策略 -------------------------------------------------------------
Write-Step "安装用户策略文件"
$dataDir = Join-Path $env:USERPROFILE ".agent-disk-guard"
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$policyTarget = Join-Path $dataDir "policy.yaml"
if ((Test-Path $policyTarget) -and -not $ForcePolicy) {
    Write-Warn2 "已存在 $policyTarget（保留用户修改；如需重置加 -ForcePolicy）"
} else {
    $defaultPolicy = Join-Path $scriptDir "config\policy.yaml"
    if (-not (Test-Path $defaultPolicy)) {
        # npm 全局安装场景：config 在包根目录
        $defaultPolicy = Join-Path (Split-Path -Parent $scriptDir) "config\policy.yaml"
    }
    if (-not (Test-Path $defaultPolicy)) {
        # 没有策略文件时，守卫会用内置默认策略（redirectRoot=D:\AgentCache）。
        # 若这时还去写环境变量，就会得到"环境变量指向 A、守卫按 B 判断"的不一致状态，故直接中止。
        throw "未找到默认策略文件（$defaultPolicy）：继续安装会造成环境变量与守卫策略口径不一致。请从发布包运行本脚本，或加 -RedirectRoot D:\AgentCache 与内置策略保持一致。"
    }
    $content = Get-Content $defaultPolicy -Raw
    $content = $content -replace 'redirectRoot:\s*"D:\\\\AgentCache"', ('redirectRoot: "' + ($RedirectRoot -replace '\\', '\\') + '"')
    Set-Content -Path $policyTarget -Value $content -Encoding UTF8
    Write-Ok "写入 $policyTarget"
}

# --- 3. 用户环境变量 ---------------------------------------------------------
Write-Step "写入用户环境变量（新开的进程生效）"

# 变量表只有一个来源：dist/cli.js 的 env 计划（即 src/envplan.ts）。
# 历史问题：脚本内置一份表、策略文件里又有 redirectRoot，两者对不上时会出现
# "环境变量指向 A、守卫按 B 判断"的不一致，这里直接让唯一来源说了算。
$cliJs = Join-Path $scriptDir "dist\cli.js"
if (-not (Test-Path $cliJs)) { $cliJs = Join-Path (Split-Path -Parent $scriptDir) "dist\cli.js" }
if (-not (Test-Path $cliJs) -or -not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "未找到 node 或 dist\cli.js（$cliJs）：请先 npm install && npm run build，或从发布包运行 install.ps1。"
}
$cliArgs = @($cliJs, "env", "--format", "json")
if ($RedirectTemp) { $cliArgs += "--include-temp" }
$plan = ((& node @cliArgs) -join "`n") | ConvertFrom-Json
$planCache = ($plan | Where-Object { $_.name -eq "npm_config_cache" } | Select-Object -First 1).value
if ($planCache) {
    $planRoot = Split-Path -Parent $planCache
    if ($planRoot.TrimEnd("\") -ne $RedirectRoot.TrimEnd("\")) {
        Write-Warn2 "策略文件的 redirectRoot 是 $planRoot，与 -RedirectRoot $RedirectRoot 不一致：环境变量按策略写入（守卫也只认策略），要改根目录请加 -ForcePolicy 重写策略。"
    }
}

# 安装前的原值只在第一次写入时记录（幂等），卸载时据此还原，而不是一律删除。
$envBackupFile = Join-Path $dataDir "env-backup.json"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
if (-not (Test-Path $envBackupFile)) { [System.IO.File]::WriteAllText($envBackupFile, "{}", $utf8NoBom) }
try { $envBackup = Get-Content $envBackupFile -Raw | ConvertFrom-Json } catch { $envBackup = New-Object psobject }
if (-not $envBackup) { $envBackup = New-Object psobject }

function Set-UserEnv($name, $value) {
    $prev = [Environment]::GetEnvironmentVariable($name, "User")
    if ($prev -eq $value) { Write-Ok "$name 已是目标值"; return }
    if (-not ($envBackup.PSObject.Properties.Name -contains $name)) {
        $envBackup | Add-Member -NotePropertyName $name -NotePropertyValue $prev -Force
    } elseif ($prev -ne $envBackup.$name) {
        Write-Warn2 "$name 当前值（$prev）不是上次写入的值，疑似被手动改过；卸载时将还原为 $($envBackup.$name)"
    }
    [Environment]::SetEnvironmentVariable($name, $value, "User")
    Write-Ok "$name = $value"
}

foreach ($v in $plan) {
    if ($v.name -eq "MAVEN_OPTS") { continue }
    Set-UserEnv $v.name $v.value
}

# MAVEN_OPTS 要保留已有的 JVM 参数，只替换 -Dmaven.repo.local
$mavenTarget = ($plan | Where-Object { $_.name -eq "MAVEN_OPTS" } | Select-Object -First 1).value
if ($mavenTarget) {
    $existingMaven = [Environment]::GetEnvironmentVariable("MAVEN_OPTS", "User")
    if (-not $existingMaven) { $existingMaven = $env:MAVEN_OPTS }
    $keptArgs = ($existingMaven -split "\s+") | Where-Object { $_ -and $_ -notmatch "^-Dmaven\.repo\.local=" }
    Set-UserEnv "MAVEN_OPTS" ((@($keptArgs) + $mavenTarget) -join " ")
}

if ($RedirectTemp) {
    Write-Warn2 "TMP/TEMP 已重定向到 $RedirectRoot\temp；个别安装器可能不兼容，可用 .\uninstall.ps1 还原"
}

[System.IO.File]::WriteAllText($envBackupFile, ($envBackup | ConvertTo-Json -Depth 5), $utf8NoBom)

# --- 4. 计划任务（可选） ------------------------------------------------------
if ($InstallScheduledTask) {
    Write-Step "注册磁盘监控计划任务（每 15 分钟）"
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) { throw "未找到 node，请先安装 Node.js 或手动指定 CliPath" }
    $cli = if ($CliPath) { $CliPath } else { Join-Path (Split-Path -Parent $scriptDir) "dist\cli.js" }
    if (-not (Test-Path $cli)) { throw "未找到 CLI: $cli" }
    $action  = New-ScheduledTaskAction -Execute $node -Argument "`"$cli`" monitor --once"
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
    Register-ScheduledTask -TaskName "AgentDiskGuard Monitor" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
    Write-Ok "计划任务 'AgentDiskGuard Monitor' 已注册（critical 时退出码 2，可在任务计划程序查看）"
}

# --- 完成 --------------------------------------------------------------------
Write-Host ""
Write-Host "安装完成。" -ForegroundColor Green
Write-Host "下一步建议："
Write-Host "  1. 重启终端使环境变量生效"
Write-Host "  2. agent-disk-guard doctor   # 自检"
Write-Host "  3. agent-disk-guard status   # 查看可迁移的 C 盘大目录"
Write-Host "  4. agent-disk-guard migrate C:\Users\$env:USERNAME\.gradle   # dry-run 预览，确认后加 --yes"
