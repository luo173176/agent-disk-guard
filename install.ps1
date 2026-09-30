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
    if (Test-Path $defaultPolicy) {
        $content = Get-Content $defaultPolicy -Raw
        $content = $content -replace 'redirectRoot:\s*"D:\\\\AgentCache"', ('redirectRoot: "' + ($RedirectRoot -replace '\\', '\\') + '"')
        Set-Content -Path $policyTarget -Value $content -Encoding UTF8
        Write-Ok "写入 $policyTarget"
    } else {
        Write-Warn2 "未找到默认策略文件，将使用内置默认策略（不影响核心功能）"
    }
}

# --- 3. 用户环境变量 ---------------------------------------------------------
Write-Step "写入用户环境变量（新开的进程生效）"
function Set-UserEnv($name, $value) {
    [Environment]::SetEnvironmentVariable($name, $value, "User")
    Write-Ok "$name = $value"
}
$vars = [ordered]@{
    "npm_config_cache"  = "$RedirectRoot\npm-cache"
    "npm_config_store_dir" = "$RedirectRoot\pnpm-store"
    "YARN_CACHE_FOLDER" = "$RedirectRoot\yarn-cache"
    "PIP_CACHE_DIR"     = "$RedirectRoot\pip"
    "UV_CACHE_DIR"      = "$RedirectRoot\uv-cache"
    "XDG_CACHE_HOME"    = "$RedirectRoot\xdg-cache"
    "CARGO_HOME"        = "$RedirectRoot\cargo"
    "RUSTUP_HOME"       = "$RedirectRoot\rustup"
    "GRADLE_USER_HOME"  = "$RedirectRoot\gradle"
    "GOPATH"            = "$RedirectRoot\go"
    "GOMODCACHE"        = "$RedirectRoot\go\pkg\mod"
    "GOCACHE"           = "$RedirectRoot\go-build"
    "DOCKER_CONFIG"     = "$RedirectRoot\docker"
    "CODEX_HOME"        = "$RedirectRoot\codex"
    "OLLAMA_MODELS"     = "$RedirectRoot\ollama\models"
    "HF_HOME"           = "$RedirectRoot\huggingface"
    "CONDA_PKGS_DIRS"   = "$RedirectRoot\conda\pkgs"
    "NUGET_PACKAGES"    = "$RedirectRoot\nuget"
}
foreach ($k in $vars.Keys) { Set-UserEnv $k $vars[$k] }

# MAVEN_OPTS 需要合并已有 JVM 参数
$existingMaven = [Environment]::GetEnvironmentVariable("MAVEN_OPTS", "User")
if (-not $existingMaven) { $existingMaven = $env:MAVEN_OPTS }
$keptArgs = ($existingMaven -split "\s+") | Where-Object { $_ -and $_ -notmatch "^-Dmaven\.repo\.local=" }
$mavenOpts = (@($keptArgs) + "-Dmaven.repo.local=$RedirectRoot\m2\repository") -join " "
Set-UserEnv "MAVEN_OPTS" $mavenOpts

if ($RedirectTemp) {
    Set-UserEnv "TMP" "$RedirectRoot\temp"
    Set-UserEnv "TEMP" "$RedirectRoot\temp"
    Write-Warn2 "TMP/TEMP 已重定向；个别安装器可能不兼容，可用 .\uninstall.ps1 还原"
}

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
