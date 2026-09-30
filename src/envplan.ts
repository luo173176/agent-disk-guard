/**
 * AgentDiskGuard — 环境变量注入计划。
 * 生成让各包管理器/工具默认使用 D 盘的完整环境变量表。
 * install.ps1 与 `agent-disk-guard env --set` 都基于本模块，保证口径一致。
 */

import { normalizePath } from "./util";
import type { Policy } from "./policy";

export interface EnvVar {
  name: string;
  value: string;
  note: string;
}

export function buildEnvPlan(policy: Policy, includeTemp = false): EnvVar[] {
  const root = normalizePath(policy.redirectRoot);
  const vars: EnvVar[] = [
    { name: "npm_config_cache", value: `${root}\\npm-cache`, note: "npm/npx 缓存" },
    { name: "npm_config_store_dir", value: `${root}\\pnpm-store`, note: "pnpm 内容寻址存储" },
    { name: "YARN_CACHE_FOLDER", value: `${root}\\yarn-cache`, note: "yarn 缓存" },
    { name: "PIP_CACHE_DIR", value: `${root}\\pip`, note: "pip 缓存" },
    { name: "UV_CACHE_DIR", value: `${root}\\uv-cache`, note: "uv 缓存" },
    { name: "XDG_CACHE_HOME", value: `${root}\\xdg-cache`, note: "XDG 通用缓存（Linux 风格工具）" },
    { name: "CARGO_HOME", value: `${root}\\cargo`, note: "cargo（crate 注册表/二进制）" },
    { name: "RUSTUP_HOME", value: `${root}\\rustup`, note: "rustup 工具链" },
    { name: "GRADLE_USER_HOME", value: `${root}\\gradle`, note: "gradle 缓存与 wrapper 发行版" },
    { name: "MAVEN_OPTS", value: `-Dmaven.repo.local=${root}\\m2\\repository`, note: "maven 本地仓库" },
    { name: "GOPATH", value: `${root}\\go`, note: "go 工作区（模块与二进制）" },
    { name: "GOMODCACHE", value: `${root}\\go\\pkg\\mod`, note: "go 模块缓存" },
    { name: "GOCACHE", value: `${root}\\go-build`, note: "go 构建缓存" },
    { name: "DOCKER_CONFIG", value: `${root}\\docker`, note: "docker 客户端配置" },
    { name: "CODEX_HOME", value: `${root}\\codex`, note: "Codex CLI 数据目录" },
    { name: "OLLAMA_MODELS", value: `${root}\\ollama\\models`, note: "ollama 模型存储" },
    { name: "HF_HOME", value: `${root}\\huggingface`, note: "HuggingFace 模型/数据集缓存" },
    { name: "CONDA_PKGS_DIRS", value: `${root}\\conda\\pkgs`, note: "conda 包缓存" },
    { name: "NUGET_PACKAGES", value: `${root}\\nuget`, note: "NuGet 全局包目录" },
  ];
  if (includeTemp) {
    vars.push({ name: "TMP", value: `${root}\\temp`, note: "临时目录（可选，可能影响个别安装器）" });
    vars.push({ name: "TEMP", value: `${root}\\temp`, note: "临时目录（可选，可能影响个别安装器）" });
  }
  return vars;
}

/** 合并既有 MAVEN_OPTS（替换旧的 -Dmaven.repo.local，保留其余 JVM 参数）。 */
export function mergeMavenOpts(existing: string | undefined, policy: Policy): string {
  const plan = buildEnvPlan(policy).find((v) => v.name === "MAVEN_OPTS")!;
  const kept = (existing || "")
    .split(/\s+/)
    .filter((x) => x && !x.startsWith("-Dmaven.repo.local="))
    .join(" ")
    .trim();
  return kept ? `${kept} ${plan.value}` : plan.value;
}
