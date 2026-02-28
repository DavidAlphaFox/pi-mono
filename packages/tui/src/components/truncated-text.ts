/**
 * @file 截断文本组件
 *
 * 提供单行文本显示功能，超出宽度时自动截断并添加省略号。
 * 适用于标题栏、状态栏等需要单行显示的场景。
 */

import type { Component } from "../tui.js";
import { truncateToWidth, visibleWidth } from "../utils.js";

/**
 * 截断文本组件 - 单行文本，超出视口宽度时截断。
 * 仅取第一行（忽略换行符后的内容）。
 */
export class TruncatedText implements Component {
	/** 文本内容 */
	private text: string;
	/** 水平内边距 */
	private paddingX: number;
	/** 垂直内边距 */
	private paddingY: number;

	constructor(text: string, paddingX: number = 0, paddingY: number = 0) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	/** 渲染截断文本，返回包含单行文本和垂直填充的行数组 */
	render(width: number): string[] {
		const result: string[] = [];

		// Empty line padded to width
		const emptyLine = " ".repeat(width);

		// Add vertical padding above
		for (let i = 0; i < this.paddingY; i++) {
			result.push(emptyLine);
		}

		// Calculate available width after horizontal padding
		const availableWidth = Math.max(1, width - this.paddingX * 2);

		// Take only the first line (stop at newline)
		let singleLineText = this.text;
		const newlineIndex = this.text.indexOf("\n");
		if (newlineIndex !== -1) {
			singleLineText = this.text.substring(0, newlineIndex);
		}

		// Truncate text if needed (accounting for ANSI codes)
		const displayText = truncateToWidth(singleLineText, availableWidth);

		// Add horizontal padding
		const leftPadding = " ".repeat(this.paddingX);
		const rightPadding = " ".repeat(this.paddingX);
		const lineWithPadding = leftPadding + displayText + rightPadding;

		// Pad line to exactly width characters
		const lineVisibleWidth = visibleWidth(lineWithPadding);
		const paddingNeeded = Math.max(0, width - lineVisibleWidth);
		const finalLine = lineWithPadding + " ".repeat(paddingNeeded);

		result.push(finalLine);

		// Add vertical padding below
		for (let i = 0; i < this.paddingY; i++) {
			result.push(emptyLine);
		}

		return result;
	}
}
