/**
 * 配置值解析模块
 *
 * 职责：
 * - 解析可能是 shell 命令、环境变量或字面量的配置值
 * - "!" 前缀：执行 shell 命令并使用 stdout（带缓存）
 * - 否则先检查环境变量，再作为字面量
 * - 供 auth-storage.ts 和 model-registry.ts 使用
 */

import { execSync } from "child_process";

// Cache for shell command results (persists for process lifetime)
const commandResultCache = new Map<string, string | undefined>();

/**
 * 将配置值（API key、请求头值等）解析为实际值
 * - "!" 开头：执行 shell 命令并使用 stdout（结果缓存）
 * - 否则先检查环境变量，再作为字面量使用（不缓存）
 */
export function resolveConfigValue(config: string): string | undefined {
	if (config.startsWith("!")) {
		return executeCommand(config);
	}
	const envValue = process.env[config];
	return envValue || config;
}

function executeCommand(commandConfig: string): string | undefined {
	if (commandResultCache.has(commandConfig)) {
		return commandResultCache.get(commandConfig);
	}

	const command = commandConfig.slice(1);
	let result: string | undefined;
	try {
		const output = execSync(command, {
			encoding: "utf-8",
			timeout: 10000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		result = output.trim() || undefined;
	} catch {
		result = undefined;
	}

	commandResultCache.set(commandConfig, result);
	return result;
}

/** 使用与 API key 相同的解析逻辑解析所有请求头值 */
export function resolveHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		const resolvedValue = resolveConfigValue(value);
		if (resolvedValue) {
			resolved[key] = resolvedValue;
		}
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/** 清除配置值命令缓存（导出供测试使用） */
export function clearConfigValueCache(): void {
	commandResultCache.clear();
}
