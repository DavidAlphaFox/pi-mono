/**
 * @file tools/read.ts - 文件读取工具
 *
 * 本文件负责：
 * 1. 定义 read 工具的参数 schema（label、path、offset、limit）
 * 2. 支持读取文本文件和图片文件
 * 3. 图片文件以 base64 编码返回，直接传给 LLM 进行视觉理解
 * 4. 文本文件支持行偏移（offset）和行数限制（limit）
 * 5. 对文本内容进行头部截断处理（超过 2000 行或 50KB 时截断）
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { extname } from "path";
import type { Executor } from "../sandbox.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

/**
 * 文件扩展名到 MIME 类型的映射（常见图片格式）
 */
const IMAGE_MIME_TYPES: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
};

/**
 * 判断文件是否为图片，返回对应的 MIME 类型
 * @param filePath - 文件路径
 * @returns MIME 类型字符串，非图片返回 null
 */
function isImageFile(filePath: string): string | null {
	const ext = extname(filePath).toLowerCase();
	return IMAGE_MIME_TYPES[ext] || null;
}

/** read 工具的参数 schema 定义 */
const readSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're reading and why (shown to user)" }),
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

/**
 * read 工具的详细信息
 */
interface ReadToolDetails {
	/** 截断信息 */
	truncation?: TruncationResult;
}

/**
 * 创建 read 工具
 * 读取文件内容，支持文本和图片格式。
 * 文本文件支持行偏移和行数限制，超长内容自动截断。
 *
 * @param executor - 命令执行器（Host 或 Docker）
 * @returns AgentTool 实例
 */
export function createReadTool(executor: Executor): AgentTool<typeof readSchema> {
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files.`,
		parameters: readSchema,
		execute: async (
			_toolCallId: string,
			{ path, offset, limit }: { label: string; path: string; offset?: number; limit?: number },
			signal?: AbortSignal,
		): Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }> => {
			const mimeType = isImageFile(path);

			if (mimeType) {
				// 图片文件：读取为 base64 编码
				const result = await executor.exec(`base64 < ${shellEscape(path)}`, { signal });
				if (result.code !== 0) {
					throw new Error(result.stderr || `Failed to read file: ${path}`);
				}
				// 移除 base64 输出中的空白字符
				const base64 = result.stdout.replace(/\s/g, "");

				return {
					content: [
						{ type: "text", text: `Read image file [${mimeType}]` },
						{ type: "image", data: base64, mimeType },
					],
					details: undefined,
				};
			}

			// 文本文件：先获取总行数
			const countResult = await executor.exec(`wc -l < ${shellEscape(path)}`, { signal });
			if (countResult.code !== 0) {
				throw new Error(countResult.stderr || `Failed to read file: ${path}`);
			}
			// wc -l 计算换行符数量，实际行数需要 +1
			const totalFileLines = Number.parseInt(countResult.stdout.trim(), 10) + 1;

			// 应用行偏移（1 索引）
			const startLine = offset ? Math.max(1, offset) : 1;
			const startLineDisplay = startLine;

			// 检查偏移是否超出文件范围
			if (startLine > totalFileLines) {
				throw new Error(`Offset ${offset} is beyond end of file (${totalFileLines} lines total)`);
			}

			// 带偏移读取文件内容
			let cmd: string;
			if (startLine === 1) {
				cmd = `cat ${shellEscape(path)}`;
			} else {
				cmd = `tail -n +${startLine} ${shellEscape(path)}`;
			}

			const result = await executor.exec(cmd, { signal });
			if (result.code !== 0) {
				throw new Error(result.stderr || `Failed to read file: ${path}`);
			}

			let selectedContent = result.stdout;
			let userLimitedLines: number | undefined;

			// 应用用户指定的行数限制
			if (limit !== undefined) {
				const lines = selectedContent.split("\n");
				const endLine = Math.min(limit, lines.length);
				selectedContent = lines.slice(0, endLine).join("\n");
				userLimitedLines = endLine;
			}

			// 应用截断（同时受行数和字节数限制）
			const truncation = truncateHead(selectedContent);

			let outputText: string;
			let details: ReadToolDetails | undefined;

			if (truncation.firstLineExceedsLimit) {
				// 第一行就超过 50KB - 提示使用 bash 工具
				const firstLineSize = formatSize(Buffer.byteLength(selectedContent.split("\n")[0], "utf-8"));
				outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
				details = { truncation };
			} else if (truncation.truncated) {
				// 发生截断 - 构建可操作的提示信息
				const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
				const nextOffset = endLineDisplay + 1;

				outputText = truncation.content;

				if (truncation.truncatedBy === "lines") {
					outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue]`;
				} else {
					outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue]`;
				}
				details = { truncation };
			} else if (userLimitedLines !== undefined) {
				// 用户指定了限制，检查是否还有更多内容
				const linesFromStart = startLine - 1 + userLimitedLines;
				if (linesFromStart < totalFileLines) {
					const remaining = totalFileLines - linesFromStart;
					const nextOffset = startLine + userLimitedLines;

					outputText = truncation.content;
					outputText += `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue]`;
				} else {
					outputText = truncation.content;
				}
			} else {
				// 无截断，无用户限制
				outputText = truncation.content;
			}

			return {
				content: [{ type: "text", text: outputText }],
				details,
			};
		},
	};
}

/**
 * Shell 参数转义
 * @param s - 要转义的字符串
 * @returns 转义后的字符串
 */
function shellEscape(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}
