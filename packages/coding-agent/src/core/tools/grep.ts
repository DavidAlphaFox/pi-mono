/**
 * 内容搜索工具（Grep）
 *
 * 本文件实现了基于 ripgrep（rg）的文件内容搜索工具，功能包括：
 * 1. 使用正则表达式或字面量字符串搜索文件内容
 * 2. 支持 glob 文件过滤、大小写不敏感搜索、上下文行显示
 * 3. 匹配数量限制（默认 100 条），超出时终止搜索
 * 4. 输出截断：超长行截断到 500 字符，总输出限制为 50KB
 * 5. 自动遵守 .gitignore 规则
 * 6. 可插拔的操作接口（GrepOperations），支持远程文件系统
 */

import { createInterface } from "node:readline";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { spawn } from "child_process";
import { readFileSync, statSync } from "fs";
import path from "path";
import { ensureTool } from "../../utils/tools-manager.js";
import { resolveToCwd } from "./path-utils.js";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	type TruncationResult,
	truncateHead,
	truncateLine,
} from "./truncate.js";

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
	),
	context: Type.Optional(
		Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

/** Grep 工具的输入参数类型 */
export type GrepToolInput = Static<typeof grepSchema>;

/** 默认匹配数量上限 */
const DEFAULT_LIMIT = 100;

/** Grep 工具的详细信息 */
export interface GrepToolDetails {
	/** 输出截断结果（如果发生了截断） */
	truncation?: TruncationResult;
	/** 达到匹配上限时的限制值 */
	matchLimitReached?: number;
	/** 是否有行被截断 */
	linesTruncated?: boolean;
}

/**
 * Grep 工具的可插拔操作接口。
 * 可通过覆写此接口将搜索委托给远程系统（如 SSH）。
 */
export interface GrepOperations {
	/** 检查路径是否为目录，路径不存在时抛出异常 */
	isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
	/** 读取文件内容（用于上下文行展示） */
	readFile: (absolutePath: string) => Promise<string> | string;
}

const defaultGrepOperations: GrepOperations = {
	isDirectory: (p) => statSync(p).isDirectory(),
	readFile: (p) => readFileSync(p, "utf-8"),
};

/** Grep 工具的配置选项 */
export interface GrepToolOptions {
	/** 自定义搜索操作，默认使用本地文件系统 + ripgrep */
	operations?: GrepOperations;
}

/**
 * 创建绑定到指定工作目录的 Grep 搜索工具实例。
 * 使用 ripgrep 执行搜索，支持正则/字面量模式、glob 过滤和上下文行。
 */
export function createGrepTool(cwd: string, options?: GrepToolOptions): AgentTool<typeof grepSchema> {
	const customOps = options?.operations;

	return {
		name: "grep",
		label: "grep",
		description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
		parameters: grepSchema,
		execute: async (
			_toolCallId: string,
			{
				pattern,
				path: searchDir,
				glob,
				ignoreCase,
				literal,
				context,
				limit,
			}: {
				pattern: string;
				path?: string;
				glob?: string;
				ignoreCase?: boolean;
				literal?: boolean;
				context?: number;
				limit?: number;
			},
			signal?: AbortSignal,
		) => {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}

				let settled = false;
				const settle = (fn: () => void) => {
					if (!settled) {
						settled = true;
						fn();
					}
				};

				(async () => {
					try {
						const rgPath = await ensureTool("rg", true);
						if (!rgPath) {
							settle(() => reject(new Error("ripgrep (rg) is not available and could not be downloaded")));
							return;
						}

						const searchPath = resolveToCwd(searchDir || ".", cwd);
						const ops = customOps ?? defaultGrepOperations;

						let isDirectory: boolean;
						try {
							isDirectory = await ops.isDirectory(searchPath);
						} catch (_err) {
							settle(() => reject(new Error(`Path not found: ${searchPath}`)));
							return;
						}
						const contextValue = context && context > 0 ? context : 0;
						const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);

						const formatPath = (filePath: string): string => {
							if (isDirectory) {
								const relative = path.relative(searchPath, filePath);
								if (relative && !relative.startsWith("..")) {
									return relative.replace(/\\/g, "/");
								}
							}
							return path.basename(filePath);
						};

						const fileCache = new Map<string, string[]>();
						const getFileLines = async (filePath: string): Promise<string[]> => {
							let lines = fileCache.get(filePath);
							if (!lines) {
								try {
									const content = await ops.readFile(filePath);
									lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
								} catch {
									lines = [];
								}
								fileCache.set(filePath, lines);
							}
							return lines;
						};

						const args: string[] = ["--json", "--line-number", "--color=never", "--hidden"];

						if (ignoreCase) {
							args.push("--ignore-case");
						}

						if (literal) {
							args.push("--fixed-strings");
						}

						if (glob) {
							args.push("--glob", glob);
						}

						args.push(pattern, searchPath);

						const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
						const rl = createInterface({ input: child.stdout });
						let stderr = "";
						let matchCount = 0;
						let matchLimitReached = false;
						let linesTruncated = false;
						let aborted = false;
						let killedDueToLimit = false;
						const outputLines: string[] = [];

						const cleanup = () => {
							rl.close();
							signal?.removeEventListener("abort", onAbort);
						};

						const stopChild = (dueToLimit: boolean = false) => {
							if (!child.killed) {
								killedDueToLimit = dueToLimit;
								child.kill();
							}
						};

						const onAbort = () => {
							aborted = true;
							stopChild();
						};

						signal?.addEventListener("abort", onAbort, { once: true });

						child.stderr?.on("data", (chunk) => {
							stderr += chunk.toString();
						});

						const formatBlock = async (filePath: string, lineNumber: number): Promise<string[]> => {
							const relativePath = formatPath(filePath);
							const lines = await getFileLines(filePath);
							if (!lines.length) {
								return [`${relativePath}:${lineNumber}: (unable to read file)`];
							}

							const block: string[] = [];
							const start = contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber;
							const end = contextValue > 0 ? Math.min(lines.length, lineNumber + contextValue) : lineNumber;

							for (let current = start; current <= end; current++) {
								const lineText = lines[current - 1] ?? "";
								const sanitized = lineText.replace(/\r/g, "");
								const isMatchLine = current === lineNumber;

								// Truncate long lines
								const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
								if (wasTruncated) {
									linesTruncated = true;
								}

								if (isMatchLine) {
									block.push(`${relativePath}:${current}: ${truncatedText}`);
								} else {
									block.push(`${relativePath}-${current}- ${truncatedText}`);
								}
							}

							return block;
						};

						// Collect matches during streaming, format after
						const matches: Array<{ filePath: string; lineNumber: number }> = [];

						rl.on("line", (line) => {
							if (!line.trim() || matchCount >= effectiveLimit) {
								return;
							}

							let event: any;
							try {
								event = JSON.parse(line);
							} catch {
								return;
							}

							if (event.type === "match") {
								matchCount++;
								const filePath = event.data?.path?.text;
								const lineNumber = event.data?.line_number;

								if (filePath && typeof lineNumber === "number") {
									matches.push({ filePath, lineNumber });
								}

								if (matchCount >= effectiveLimit) {
									matchLimitReached = true;
									stopChild(true);
								}
							}
						});

						child.on("error", (error) => {
							cleanup();
							settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
						});

						child.on("close", async (code) => {
							cleanup();

							if (aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}

							if (!killedDueToLimit && code !== 0 && code !== 1) {
								const errorMsg = stderr.trim() || `ripgrep exited with code ${code}`;
								settle(() => reject(new Error(errorMsg)));
								return;
							}

							if (matchCount === 0) {
								settle(() =>
									resolve({ content: [{ type: "text", text: "No matches found" }], details: undefined }),
								);
								return;
							}

							// Format matches (async to support remote file reading)
							for (const match of matches) {
								const block = await formatBlock(match.filePath, match.lineNumber);
								outputLines.push(...block);
							}

							// Apply byte truncation (no line limit since we already have match limit)
							const rawOutput = outputLines.join("\n");
							const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });

							let output = truncation.content;
							const details: GrepToolDetails = {};

							// Build notices
							const notices: string[] = [];

							if (matchLimitReached) {
								notices.push(
									`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
								);
								details.matchLimitReached = effectiveLimit;
							}

							if (truncation.truncated) {
								notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
								details.truncation = truncation;
							}

							if (linesTruncated) {
								notices.push(
									`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
								);
								details.linesTruncated = true;
							}

							if (notices.length > 0) {
								output += `\n\n[${notices.join(". ")}]`;
							}

							settle(() =>
								resolve({
									content: [{ type: "text", text: output }],
									details: Object.keys(details).length > 0 ? details : undefined,
								}),
							);
						});
					} catch (err) {
						settle(() => reject(err as Error));
					}
				})();
			});
		},
	};
}

/** 使用 process.cwd() 的默认 Grep 工具实例，保持向后兼容 */
export const grepTool = createGrepTool(process.cwd());
