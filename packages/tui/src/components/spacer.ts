/**
 * @file 间隔组件
 *
 * 提供简单的空行间隔，用于在组件之间添加垂直空白。
 */

import type { Component } from "../tui.js";

/**
 * 间隔组件 - 渲染指定数量的空行。
 * 用于在其他组件之间添加垂直间距。
 */
export class Spacer implements Component {
	/** 空行数量 */
	private lines: number;

	constructor(lines: number = 1) {
		this.lines = lines;
	}

	/** 设置空行数量 */
	setLines(lines: number): void {
		this.lines = lines;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(_width: number): string[] {
		const result: string[] = [];
		for (let i = 0; i < this.lines; i++) {
			result.push("");
		}
		return result;
	}
}
