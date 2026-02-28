/**
 * 文件查找工具（Find）
 *
 * 本文件实现了基于 glob 模式的文件查找工具，功能包括：
 * 1. 使用 fd 命令按 glob 模式搜索文件
 * 2. 支持结果数量限制（默认 1000 条）
 * 3. 自动遵守 .gitignore 规则（包括嵌套的 .gitignore）
 * 4. 输出截断：总输出限制为 50KB
 * 5. 返回相对于搜索目录的路径，目录带 "/" 后缀
 * 6. 可插拔的操作接口（FindOperations），支持远程文件系统
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { globSync } from "glob";
import path from "path";
import { ensureTool } from "../../utils/tools-manager.js";
import { resolveToCwd } from "./path-utils.js";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

const findSchema = Type.Object({
	pattern: Type.String({
		description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
	}),
	path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
});

/** Find 工具的输入参数类型 */
export type FindToolInput = Static<typeof findSchema>;

/** 默认结果数量上限 */
const DEFAULT_LIMIT = 1000;

/** Find 工具的详细信息 */
export interface FindToolDetails {
	/** 输出截断结果（如果发生了截断） */
	truncation?: TruncationResult;
	/** 达到结果上限时的限制值 */
	resultLimitReached?: number;
}

/**
 * Find 工具的可插拔操作接口。
 * 可通过覆写此接口将文件查找委托给远程系统（如 SSH）。
 */
export interface FindOperations {
	/** 检查路径是否存在 */
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** 按 glob 模式查找文件，返回相对路径列表 */
	glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => Promise<string[]> | string[];
}

const defaultFindOperations: FindOperations = {
	exists: existsSync,
	glob: (_pattern, _searchCwd, _options) => {
		// This is a placeholder - actual fd execution happens in execute
		return [];
	},
};

/** Find 工具的配置选项 */
export interface FindToolOptions {
	/** 自定义文件查找操作，默认使用本地文件系统 + fd */
	operations?: FindOperations;
}

/**
 * 创建绑定到指定工作目录的文件查找工具实例。
 * 使用 fd 命令按 glob 模式搜索文件，遵守 .gitignore 规则。
 */
export function createFindTool(cwd: string, options?: FindToolOptions): AgentTool<typeof findSchema> {
	const customOps = options?.operations;

	return {
		name: "find",
		label: "find",
		description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		parameters: findSchema,
		execute: async (
			_toolCallId: string,
			{ pattern, path: searchDir, limit }: { pattern: string; path?: string; limit?: number },
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
						const searchPath = resolveToCwd(searchDir || ".", cwd);
						const effectiveLimit = limit ?? DEFAULT_LIMIT;
						const ops = customOps ?? defaultFindOperations;

						// If custom operations provided with glob, use that
						if (customOps?.glob) {
							if (!(await ops.exists(searchPath))) {
								reject(new Error(`Path not found: ${searchPath}`));
								return;
							}

							const results = await ops.glob(pattern, searchPath, {
								ignore: ["**/node_modules/**", "**/.git/**"],
								limit: effectiveLimit,
							});

							signal?.removeEventListener("abort", onAbort);

							if (results.length === 0) {
								resolve({
									content: [{ type: "text", text: "No files found matching pattern" }],
									details: undefined,
								});
								return;
							}

							// Relativize paths
							const relativized = results.map((p) => {
								if (p.startsWith(searchPath)) {
									return p.slice(searchPath.length + 1);
								}
								return path.relative(searchPath, p);
							});

							const resultLimitReached = relativized.length >= effectiveLimit;
							const rawOutput = relativized.join("\n");
							const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });

							let resultOutput = truncation.content;
							const details: FindToolDetails = {};
							const notices: string[] = [];

							if (resultLimitReached) {
								notices.push(`${effectiveLimit} results limit reached`);
								details.resultLimitReached = effectiveLimit;
							}

							if (truncation.truncated) {
								notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
								details.truncation = truncation;
							}

							if (notices.length > 0) {
								resultOutput += `\n\n[${notices.join(". ")}]`;
							}

							resolve({
								content: [{ type: "text", text: resultOutput }],
								details: Object.keys(details).length > 0 ? details : undefined,
							});
							return;
						}

						// Default: use fd
						const fdPath = await ensureTool("fd", true);
						if (!fdPath) {
							reject(new Error("fd is not available and could not be downloaded"));
							return;
						}

						// Build fd arguments
						const args: string[] = [
							"--glob",
							"--color=never",
							"--hidden",
							"--max-results",
							String(effectiveLimit),
						];

						// Include .gitignore files
						const gitignoreFiles = new Set<string>();
						const rootGitignore = path.join(searchPath, ".gitignore");
						if (existsSync(rootGitignore)) {
							gitignoreFiles.add(rootGitignore);
						}

						try {
							const nestedGitignores = globSync("**/.gitignore", {
								cwd: searchPath,
								dot: true,
								absolute: true,
								ignore: ["**/node_modules/**", "**/.git/**"],
							});
							for (const file of nestedGitignores) {
								gitignoreFiles.add(file);
							}
						} catch {
							// Ignore glob errors
						}

						for (const gitignorePath of gitignoreFiles) {
							args.push("--ignore-file", gitignorePath);
						}

						args.push(pattern, searchPath);

						const result = spawnSync(fdPath, args, {
							encoding: "utf-8",
							maxBuffer: 10 * 1024 * 1024,
						});

						signal?.removeEventListener("abort", onAbort);

						if (result.error) {
							reject(new Error(`Failed to run fd: ${result.error.message}`));
							return;
						}

						const output = result.stdout?.trim() || "";

						if (result.status !== 0) {
							const errorMsg = result.stderr?.trim() || `fd exited with code ${result.status}`;
							if (!output) {
								reject(new Error(errorMsg));
								return;
							}
						}

						if (!output) {
							resolve({
								content: [{ type: "text", text: "No files found matching pattern" }],
								details: undefined,
							});
							return;
						}

						const lines = output.split("\n");
						const relativized: string[] = [];

						for (const rawLine of lines) {
							const line = rawLine.replace(/\r$/, "").trim();
							if (!line) continue;

							const hadTrailingSlash = line.endsWith("/") || line.endsWith("\\");
							let relativePath = line;
							if (line.startsWith(searchPath)) {
								relativePath = line.slice(searchPath.length + 1);
							} else {
								relativePath = path.relative(searchPath, line);
							}

							if (hadTrailingSlash && !relativePath.endsWith("/")) {
								relativePath += "/";
							}

							relativized.push(relativePath);
						}

						const resultLimitReached = relativized.length >= effectiveLimit;
						const rawOutput = relativized.join("\n");
						const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });

						let resultOutput = truncation.content;
						const details: FindToolDetails = {};
						const notices: string[] = [];

						if (resultLimitReached) {
							notices.push(
								`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
							);
							details.resultLimitReached = effectiveLimit;
						}

						if (truncation.truncated) {
							notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
							details.truncation = truncation;
						}

						if (notices.length > 0) {
							resultOutput += `\n\n[${notices.join(". ")}]`;
						}

						resolve({
							content: [{ type: "text", text: resultOutput }],
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

/** 使用 process.cwd() 的默认 Find 工具实例，保持向后兼容 */
export const findTool = createFindTool(process.cwd());
