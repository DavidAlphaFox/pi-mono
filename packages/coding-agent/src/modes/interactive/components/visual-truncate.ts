/**
 * 可视行截断工具。
 *
 * 该文件提供将文本截断为指定可视行数的功能，
 * 考虑了终端宽度导致的自动换行。
 * 被 tool-execution.ts 和 bash-execution.ts 共同使用，以保持一致的截断行为。
 */

import { Text } from "@mariozechner/pi-tui";

/**
 * 可视行截断结果接口。
 */
export interface VisualTruncateResult {
	/** 要显示的可视行数组 */
	visualLines: string[];
	/** 被跳过（隐藏）的可视行数 */
	skippedCount: number;
}

/**
 * 将文本截断为最大可视行数（从末尾保留）。
 * 该函数考虑了终端宽度导致的自动换行，计算的是实际显示行数而非逻辑行数。
 *
 * @param text - 文本内容（可能包含换行符）
 * @param maxVisualLines - 最大显示的可视行数
 * @param width - 终端/渲染宽度
 * @param paddingX - Text 组件的水平内边距（默认 0）。
 *                   在 Box 内使用时设为 0（Box 自带内边距），
 *                   在普通 Container 内使用时设为 1。
 * @returns 截断后的可视行和被跳过的行数
 */
export function truncateToVisualLines(
	text: string,
	maxVisualLines: number,
	width: number,
	paddingX: number = 0,
): VisualTruncateResult {
	if (!text) {
		return { visualLines: [], skippedCount: 0 };
	}

	// Create a temporary Text component to render and get visual lines
	const tempText = new Text(text, paddingX, 0);
	const allVisualLines = tempText.render(width);

	if (allVisualLines.length <= maxVisualLines) {
		return { visualLines: allVisualLines, skippedCount: 0 };
	}

	// Take the last N visual lines
	const truncatedLines = allVisualLines.slice(-maxVisualLines);
	const skippedCount = allVisualLines.length - maxVisualLines;

	return { visualLines: truncatedLines, skippedCount };
}
