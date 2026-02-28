/**
 * @file tools/edit.ts - 文件编辑工具
 *
 * 本文件负责：
 * 1. 定义 edit 工具的参数 schema（label、path、oldText、newText）
 * 2. 通过精确文本匹配进行文件编辑（查找并替换）
 * 3. 校验匹配唯一性（不允许多处匹配）
 * 4. 生成统一 diff 格式的变更记录
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import * as Diff from "diff";
import type { Executor } from "../sandbox.js";

/**
 * 生成带行号和上下文的统一 diff 字符串
 * 使用 +/- 前缀标记新增/删除的行，周围保留上下文行
 *
 * @param oldContent - 原始文件内容
 * @param newContent - 修改后的文件内容
 * @param contextLines - 变更周围显示的上下文行数（默认 4）
 * @returns 格式化后的 diff 字符串
 */
function generateDiffString(oldContent: string, newContent: string, contextLines = 4): string {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	// 计算行号显示宽度
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		// 移除尾部空行（split 产生的）
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			// 新增或删除的行，带 +/- 前缀
			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			// 未变更的行 - 仅在变更前后显示上下文
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);

			if (lastWasChange || nextPartIsChange) {
				let linesToShow = raw;
				let skipStart = 0;
				let skipEnd = 0;

				// 如果不是紧跟在变更之后，只显示末尾的上下文行
				if (!lastWasChange) {
					skipStart = Math.max(0, raw.length - contextLines);
					linesToShow = raw.slice(skipStart);
				}

				// 如果后面没有变更，只显示开头的上下文行
				if (!nextPartIsChange && linesToShow.length > contextLines) {
					skipEnd = linesToShow.length - contextLines;
					linesToShow = linesToShow.slice(0, contextLines);
				}

				// 跳过的行用 "..." 表示
				if (skipStart > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
				}

				for (const line of linesToShow) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}

				if (skipEnd > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
				}

				oldLineNum += skipStart + skipEnd;
				newLineNum += skipStart + skipEnd;
			} else {
				// 远离变更的未修改行 - 完全跳过
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return output.join("\n");
}

/** edit 工具的参数 schema 定义 */
const editSchema = Type.Object({
	label: Type.String({ description: "Brief description of the edit you're making (shown to user)" }),
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	oldText: Type.String({ description: "Exact text to find and replace (must match exactly)" }),
	newText: Type.String({ description: "New text to replace the old text with" }),
});

/**
 * 创建 edit 工具
 * 通过精确文本匹配进行文件编辑。
 * 要求 oldText 必须精确匹配（包含空白字符），且在文件中唯一。
 *
 * @param executor - 命令执行器（Host 或 Docker）
 * @returns AgentTool 实例
 */
export function createEditTool(executor: Executor): AgentTool<typeof editSchema> {
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits.",
		parameters: editSchema,
		execute: async (
			_toolCallId: string,
			{ path, oldText, newText }: { label: string; path: string; oldText: string; newText: string },
			signal?: AbortSignal,
		) => {
			// 读取文件内容
			const readResult = await executor.exec(`cat ${shellEscape(path)}`, { signal });
			if (readResult.code !== 0) {
				throw new Error(readResult.stderr || `File not found: ${path}`);
			}

			const content = readResult.stdout;

			// 检查目标文本是否存在
			if (!content.includes(oldText)) {
				throw new Error(
					`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
				);
			}

			// 检查匹配唯一性（不允许多处匹配）
			const occurrences = content.split(oldText).length - 1;

			if (occurrences > 1) {
				throw new Error(
					`Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
				);
			}

			// 执行替换
			const index = content.indexOf(oldText);
			const newContent = content.substring(0, index) + newText + content.substring(index + oldText.length);

			// 检查替换是否产生了变化
			if (content === newContent) {
				throw new Error(
					`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
				);
			}

			// 将修改后的内容写回文件
			const writeResult = await executor.exec(`printf '%s' ${shellEscape(newContent)} > ${shellEscape(path)}`, {
				signal,
			});
			if (writeResult.code !== 0) {
				throw new Error(writeResult.stderr || `Failed to write file: ${path}`);
			}

			return {
				content: [
					{
						type: "text",
						text: `Successfully replaced text in ${path}. Changed ${oldText.length} characters to ${newText.length} characters.`,
					},
				],
				details: { diff: generateDiffString(content, newContent) },
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
