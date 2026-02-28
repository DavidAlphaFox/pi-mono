/**
 * 目录列表工具（Ls）
 *
 * 本文件实现了列出目录内容的工具，功能包括：
 * 1. 列出指定目录下的文件和子目录，按字母排序
 * 2. 目录名带 "/" 后缀标识，包含隐藏文件（dotfiles）
 * 3. 支持条目数量限制（默认 500 条）
 * 4. 输出截断：总输出限制为 50KB
 * 5. 可插拔的操作接口（LsOperations），支持远程文件系统
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { existsSync, readdirSync, statSync } from "fs";
import nodePath from "path";
import { resolveToCwd } from "./path-utils.js";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

const lsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)" })),
});

/** Ls 工具的输入参数类型 */
export type LsToolInput = Static<typeof lsSchema>;

/** 默认条目数量上限 */
const DEFAULT_LIMIT = 500;

/** Ls 工具的详细信息 */
export interface LsToolDetails {
	/** 输出截断结果（如果发生了截断） */
	truncation?: TruncationResult;
	/** 达到条目上限时的限制值 */
	entryLimitReached?: number;
}

/**
 * Ls 工具的可插拔操作接口。
 * 可通过覆写此接口将目录列表委托给远程系统（如 SSH）。
 */
export interface LsOperations {
	/** 检查路径是否存在 */
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** 获取文件/目录的状态信息，不存在时抛出异常 */
	stat: (absolutePath: string) => Promise<{ isDirectory: () => boolean }> | { isDirectory: () => boolean };
	/** 读取目录中的条目列表 */
	readdir: (absolutePath: string) => Promise<string[]> | string[];
}

const defaultLsOperations: LsOperations = {
	exists: existsSync,
	stat: statSync,
	readdir: readdirSync,
};

/** Ls 工具的配置选项 */
export interface LsToolOptions {
	/** 自定义目录列表操作，默认使用本地文件系统 */
	operations?: LsOperations;
}

/**
 * 创建绑定到指定工作目录的目录列表工具实例。
 * 列出目录内容并标识子目录。
 */
export function createLsTool(cwd: string, options?: LsToolOptions): AgentTool<typeof lsSchema> {
	const ops = options?.operations ?? defaultLsOperations;

	return {
		name: "ls",
		label: "ls",
		description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		parameters: lsSchema,
		execute: async (
			_toolCallId: string,
			{ path, limit }: { path?: string; limit?: number },
			signal?: AbortSignal,
		) => {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}

				const onAbort = () => reject(new Error("Operation aborted"));
				signal?.addEventListener("abort", onAbort, { once: true });

				(async () => {
					try {
						const dirPath = resolveToCwd(path || ".", cwd);
						const effectiveLimit = limit ?? DEFAULT_LIMIT;

						// Check if path exists
						if (!(await ops.exists(dirPath))) {
							reject(new Error(`Path not found: ${dirPath}`));
							return;
						}

						// Check if path is a directory
						const stat = await ops.stat(dirPath);
						if (!stat.isDirectory()) {
							reject(new Error(`Not a directory: ${dirPath}`));
							return;
						}

						// Read directory entries
						let entries: string[];
						try {
							entries = await ops.readdir(dirPath);
						} catch (e: any) {
							reject(new Error(`Cannot read directory: ${e.message}`));
							return;
						}

						// Sort alphabetically (case-insensitive)
						entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

						// Format entries with directory indicators
						const results: string[] = [];
						let entryLimitReached = false;

						for (const entry of entries) {
							if (results.length >= effectiveLimit) {
								entryLimitReached = true;
								break;
							}

							const fullPath = nodePath.join(dirPath, entry);
							let suffix = "";

							try {
								const entryStat = await ops.stat(fullPath);
								if (entryStat.isDirectory()) {
									suffix = "/";
								}
							} catch {
								// Skip entries we can't stat
								continue;
							}

							results.push(entry + suffix);
						}

						signal?.removeEventListener("abort", onAbort);

						if (results.length === 0) {
							resolve({ content: [{ type: "text", text: "(empty directory)" }], details: undefined });
							return;
						}

						// Apply byte truncation (no line limit since we already have entry limit)
						const rawOutput = results.join("\n");
						const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });

						let output = truncation.content;
						const details: LsToolDetails = {};

						// Build notices
						const notices: string[] = [];

						if (entryLimitReached) {
							notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
							details.entryLimitReached = effectiveLimit;
						}

						if (truncation.truncated) {
							notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
							details.truncation = truncation;
						}

						if (notices.length > 0) {
							output += `\n\n[${notices.join(". ")}]`;
						}

						resolve({
							content: [{ type: "text", text: output }],
							details: Object.keys(details).length > 0 ? details : undefined,
						});
					} catch (e: any) {
						signal?.removeEventListener("abort", onAbort);
						reject(e);
					}
				})();
			});
		},
	};
}

/** 使用 process.cwd() 的默认 Ls 工具实例，保持向后兼容 */
export const lsTool = createLsTool(process.cwd());
