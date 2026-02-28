/**
 * 文件编辑工具
 *
 * 本文件实现了通过精确文本替换来编辑文件的工具，功能包括：
 * 1. 精确匹配旧文本并替换为新文本（查找-替换模式）
 * 2. 支持模糊匹配：自动处理尾随空白、Unicode 引号/破折号差异
 * 3. 唯一性校验：旧文本必须在文件中唯一出现，否则报错
 * 4. 保留原始换行符风格（CRLF/LF）和 BOM 标记
 * 5. 生成 unified diff 用于变更预览
 * 6. 可插拔的编辑操作（EditOperations），支持远程文件系统
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import {
	detectLineEnding,
	fuzzyFindText,
	generateDiffString,
	normalizeForFuzzyMatch,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.js";
import { resolveToCwd } from "./path-utils.js";

const editSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	oldText: Type.String({ description: "Exact text to find and replace (must match exactly)" }),
	newText: Type.String({ description: "New text to replace the old text with" }),
});

/** 编辑工具的输入参数类型 */
export type EditToolInput = Static<typeof editSchema>;

/** 编辑工具的详细信息 */
export interface EditToolDetails {
	/** 变更的 unified diff 格式字符串 */
	diff: string;
	/** 新文件中第一个变更的行号（用于编辑器导航） */
	firstChangedLine?: number;
}

/**
 * 编辑工具的可插拔操作接口。
 * 可通过覆写此接口将文件编辑委托给远程系统（如 SSH）。
 */
export interface EditOperations {
	/** 读取文件内容，返回 Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** 将内容写入文件 */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** 检查文件是否可读写（不可时抛出异常） */
	access: (absolutePath: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
	readFile: (path) => fsReadFile(path),
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

/** 编辑工具的配置选项 */
export interface EditToolOptions {
	/** 自定义文件编辑操作，默认使用本地文件系统 */
	operations?: EditOperations;
}

/**
 * 创建绑定到指定工作目录的文件编辑工具实例。
 * 通过精确文本匹配（支持模糊匹配）进行查找替换操作。
 */
export function createEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof editSchema> {
	const ops = options?.operations ?? defaultEditOperations;

	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits.",
		parameters: editSchema,
		execute: async (
			_toolCallId: string,
			{ path, oldText, newText }: { path: string; oldText: string; newText: string },
			signal?: AbortSignal,
		) => {
			const absolutePath = resolveToCwd(path, cwd);

			return new Promise<{
				content: Array<{ type: "text"; text: string }>;
				details: EditToolDetails | undefined;
			}>((resolve, reject) => {
				// Check if already aborted
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}

				let aborted = false;

				// Set up abort handler
				const onAbort = () => {
					aborted = true;
					reject(new Error("Operation aborted"));
				};

				if (signal) {
					signal.addEventListener("abort", onAbort, { once: true });
				}

				// Perform the edit operation
				(async () => {
					try {
						// Check if file exists
						try {
							await ops.access(absolutePath);
						} catch {
							if (signal) {
								signal.removeEventListener("abort", onAbort);
							}
							reject(new Error(`File not found: ${path}`));
							return;
						}

						// Check if aborted before reading
						if (aborted) {
							return;
						}

						// Read the file
						const buffer = await ops.readFile(absolutePath);
						const rawContent = buffer.toString("utf-8");

						// Check if aborted after reading
						if (aborted) {
							return;
						}

						// Strip BOM before matching (LLM won't include invisible BOM in oldText)
						const { bom, text: content } = stripBom(rawContent);

						const originalEnding = detectLineEnding(content);
						const normalizedContent = normalizeToLF(content);
						const normalizedOldText = normalizeToLF(oldText);
						const normalizedNewText = normalizeToLF(newText);

						// Find the old text using fuzzy matching (tries exact match first, then fuzzy)
						const matchResult = fuzzyFindText(normalizedContent, normalizedOldText);

						if (!matchResult.found) {
							if (signal) {
								signal.removeEventListener("abort", onAbort);
							}
							reject(
								new Error(
									`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
								),
							);
							return;
						}

						// Count occurrences using fuzzy-normalized content for consistency
						const fuzzyContent = normalizeForFuzzyMatch(normalizedContent);
						const fuzzyOldText = normalizeForFuzzyMatch(normalizedOldText);
						const occurrences = fuzzyContent.split(fuzzyOldText).length - 1;

						if (occurrences > 1) {
							if (signal) {
								signal.removeEventListener("abort", onAbort);
							}
							reject(
								new Error(
									`Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
								),
							);
							return;
						}

						// Check if aborted before writing
						if (aborted) {
							return;
						}

						// Perform replacement using the matched text position
						// When fuzzy matching was used, contentForReplacement is the normalized version
						const baseContent = matchResult.contentForReplacement;
						const newContent =
							baseContent.substring(0, matchResult.index) +
							normalizedNewText +
							baseContent.substring(matchResult.index + matchResult.matchLength);

						// Verify the replacement actually changed something
						if (baseContent === newContent) {
							if (signal) {
								signal.removeEventListener("abort", onAbort);
							}
							reject(
								new Error(
									`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
								),
							);
							return;
						}

						const finalContent = bom + restoreLineEndings(newContent, originalEnding);
						await ops.writeFile(absolutePath, finalContent);

						// Check if aborted after writing
						if (aborted) {
							return;
						}

						// Clean up abort handler
						if (signal) {
							signal.removeEventListener("abort", onAbort);
						}

						const diffResult = generateDiffString(baseContent, newContent);
						resolve({
							content: [
								{
									type: "text",
									text: `Successfully replaced text in ${path}.`,
								},
							],
							details: { diff: diffResult.diff, firstChangedLine: diffResult.firstChangedLine },
						});
					} catch (error: any) {
						// Clean up abort handler
						if (signal) {
							signal.removeEventListener("abort", onAbort);
						}

						if (!aborted) {
							reject(error);
						}
					}
				})();
			});
		},
	};
}

/** 使用 process.cwd() 的默认编辑工具实例，保持向后兼容 */
export const editTool = createEditTool(process.cwd());
