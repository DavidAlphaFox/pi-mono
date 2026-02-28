/**
 * 应用配置与路径管理模块
 *
 * 职责：
 * - 检测包的运行环境（Bun 编译二进制文件 / Node.js / tsx 开发模式）
 * - 检测安装方式（npm/pnpm/yarn/bun/bun-binary）
 * - 提供包内资源路径（主题、导出模板、package.json 等）
 * - 从 package.json 中读取应用配置（名称、配置目录名、版本号）
 * - 提供用户配置目录下各种文件的路径（会话、设置、模型、认证等）
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

// =============================================================================
// 包环境检测
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * 检测是否作为 Bun 编译的二进制文件运行。
 * Bun 二进制文件的 import.meta.url 包含 "$bunfs"、"~BUN" 或 "%7EBUN"（Bun 虚拟文件系统路径）
 */
export const isBunBinary =
	import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

/** 检测 Bun 是否为当前运行时（编译二进制或 bun run） */
export const isBunRuntime = !!process.versions.bun;

// =============================================================================
// 安装方式检测
// =============================================================================

/** 支持的安装方式类型 */
export type InstallMethod = "bun-binary" | "npm" | "pnpm" | "yarn" | "bun" | "unknown";

/** 根据运行时路径和环境检测当前的安装方式 */
export function detectInstallMethod(): InstallMethod {
	if (isBunBinary) {
		return "bun-binary";
	}

	const resolvedPath = `${__dirname}\0${process.execPath || ""}`.toLowerCase();

	if (resolvedPath.includes("/pnpm/") || resolvedPath.includes("/.pnpm/") || resolvedPath.includes("\\pnpm\\")) {
		return "pnpm";
	}
	if (resolvedPath.includes("/yarn/") || resolvedPath.includes("/.yarn/") || resolvedPath.includes("\\yarn\\")) {
		return "yarn";
	}
	if (isBunRuntime) {
		return "bun";
	}
	if (resolvedPath.includes("/npm/") || resolvedPath.includes("/node_modules/") || resolvedPath.includes("\\npm\\")) {
		return "npm";
	}

	return "unknown";
}

/** 根据当前安装方式生成对应的更新指令 */
export function getUpdateInstruction(packageName: string): string {
	const method = detectInstallMethod();
	switch (method) {
		case "bun-binary":
			return `Download from: https://github.com/badlogic/pi-mono/releases/latest`;
		case "pnpm":
			return `Run: pnpm install -g ${packageName}`;
		case "yarn":
			return `Run: yarn global add ${packageName}`;
		case "bun":
			return `Run: bun install -g ${packageName}`;
		case "npm":
			return `Run: npm install -g ${packageName}`;
		default:
			return `Run: npm install -g ${packageName}`;
	}
}

// =============================================================================
// 包资源路径（随可执行文件一起分发）
// =============================================================================

/**
 * 获取包资源的基础目录（主题、package.json、README.md、CHANGELOG.md 等）。
 * - Bun 二进制：返回可执行文件所在目录
 * - Node.js (dist/)：返回 __dirname（dist/ 目录）
 * - tsx (src/)：返回上级目录（包根目录）
 *
 * 支持通过 PI_PACKAGE_DIR 环境变量覆盖（适用于 Nix/Guix 等分发环境）
 */
export function getPackageDir(): string {
	// Allow override via environment variable (useful for Nix/Guix where store paths tokenize poorly)
	const envDir = process.env.PI_PACKAGE_DIR;
	if (envDir) {
		if (envDir === "~") return homedir();
		if (envDir.startsWith("~/")) return homedir() + envDir.slice(1);
		return envDir;
	}

	if (isBunBinary) {
		// Bun binary: process.execPath points to the compiled executable
		return dirname(process.execPath);
	}
	// Node.js: walk up from __dirname until we find package.json
	let dir = __dirname;
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) {
			return dir;
		}
		dir = dirname(dir);
	}
	// Fallback (shouldn't happen)
	return __dirname;
}

/**
 * 获取内置主题目录路径（随包分发）
 * - Bun 二进制：可执行文件旁的 theme/
 * - Node.js (dist/)：dist/modes/interactive/theme/
 * - tsx (src/)：src/modes/interactive/theme/
 */
export function getThemesDir(): string {
	if (isBunBinary) {
		return join(dirname(process.execPath), "theme");
	}
	// Theme is in modes/interactive/theme/ relative to src/ or dist/
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "modes", "interactive", "theme");
}

/**
 * 获取 HTML 导出模板目录路径（随包分发）
 * - Bun 二进制：可执行文件旁的 export-html/
 * - Node.js (dist/)：dist/core/export-html/
 * - tsx (src/)：src/core/export-html/
 */
export function getExportTemplateDir(): string {
	if (isBunBinary) {
		return join(dirname(process.execPath), "export-html");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "core", "export-html");
}

/** 获取 package.json 路径 */
export function getPackageJsonPath(): string {
	return join(getPackageDir(), "package.json");
}

/** 获取 README.md 路径 */
export function getReadmePath(): string {
	return resolve(join(getPackageDir(), "README.md"));
}

/** 获取文档目录路径 */
export function getDocsPath(): string {
	return resolve(join(getPackageDir(), "docs"));
}

/** 获取示例目录路径 */
export function getExamplesPath(): string {
	return resolve(join(getPackageDir(), "examples"));
}

/** 获取 CHANGELOG.md 路径 */
export function getChangelogPath(): string {
	return resolve(join(getPackageDir(), "CHANGELOG.md"));
}

// =============================================================================
// 应用配置（来自 package.json 的 piConfig 字段）
// =============================================================================

const pkg = JSON.parse(readFileSync(getPackageJsonPath(), "utf-8"));

/** 应用名称（默认 "pi"） */
export const APP_NAME: string = pkg.piConfig?.name || "pi";
/** 配置目录名称（默认 ".pi"） */
export const CONFIG_DIR_NAME: string = pkg.piConfig?.configDir || ".pi";
/** 当前版本号 */
export const VERSION: string = pkg.version;

// 环境变量名，例如 PI_CODING_AGENT_DIR 或 TAU_CODING_AGENT_DIR
export const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;

const DEFAULT_SHARE_VIEWER_URL = "https://pi.dev/session/";

/** 根据 Gist ID 获取分享查看器 URL */
export function getShareViewerUrl(gistId: string): string {
	const baseUrl = process.env.PI_SHARE_VIEWER_URL || DEFAULT_SHARE_VIEWER_URL;
	return `${baseUrl}#${gistId}`;
}

// =============================================================================
// 用户配置路径 (~/.pi/agent/*)
// =============================================================================

/** 获取智能体配置目录（例如 ~/.pi/agent/），支持通过环境变量覆盖 */
export function getAgentDir(): string {
	const envDir = process.env[ENV_AGENT_DIR];
	if (envDir) {
		// Expand tilde to home directory
		if (envDir === "~") return homedir();
		if (envDir.startsWith("~/")) return homedir() + envDir.slice(1);
		return envDir;
	}
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

/** 获取用户自定义主题目录路径 */
export function getCustomThemesDir(): string {
	return join(getAgentDir(), "themes");
}

/** 获取 models.json 路径 */
export function getModelsPath(): string {
	return join(getAgentDir(), "models.json");
}

/** 获取 auth.json 路径 */
export function getAuthPath(): string {
	return join(getAgentDir(), "auth.json");
}

/** 获取 settings.json 路径 */
export function getSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

/** 获取工具目录路径 */
export function getToolsDir(): string {
	return join(getAgentDir(), "tools");
}

/** 获取托管二进制文件目录路径（fd, rg） */
export function getBinDir(): string {
	return join(getAgentDir(), "bin");
}

/** 获取提示模板目录路径 */
export function getPromptsDir(): string {
	return join(getAgentDir(), "prompts");
}

/** 获取会话目录路径 */
export function getSessionsDir(): string {
	return join(getAgentDir(), "sessions");
}

/** 获取调试日志文件路径 */
export function getDebugLogPath(): string {
	return join(getAgentDir(), `${APP_NAME}-debug.log`);
}
