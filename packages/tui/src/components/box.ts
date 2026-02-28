/**
 * @file Box 容器组件
 *
 * 提供一个容器组件，为所有子组件统一应用内边距和背景色。
 * 渲染结果会被缓存，通过对比子组件输出和背景色采样来判断是否需要重新渲染。
 */

import type { Component } from "../tui.js";
import { applyBackgroundToLine, visibleWidth } from "../utils.js";

/** 渲染缓存结构 */
type RenderCache = {
	/** 子组件渲染的行（含左内边距） */
	childLines: string[];
	/** 渲染时的宽度 */
	width: number;
	/** 背景色函数的采样输出（用于检测背景色变化） */
	bgSample: string | undefined;
	/** 最终渲染结果 */
	lines: string[];
};

/**
 * Box 容器组件 - 为所有子组件应用统一的内边距和背景色。
 * 子组件按添加顺序垂直排列渲染。
 */
export class Box implements Component {
	/** 子组件列表 */
	children: Component[] = [];
	/** 水平内边距 */
	private paddingX: number;
	/** 垂直内边距 */
	private paddingY: number;
	/** 背景色函数 */
	private bgFn?: (text: string) => string;

	// 渲染输出缓存
	private cache?: RenderCache;

	constructor(paddingX = 1, paddingY = 1, bgFn?: (text: string) => string) {
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.bgFn = bgFn;
	}

	/** 添加子组件 */
	addChild(component: Component): void {
		this.children.push(component);
		this.invalidateCache();
	}

	/** 移除子组件 */
	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
			this.invalidateCache();
		}
	}

	/** 清除所有子组件 */
	clear(): void {
		this.children = [];
		this.invalidateCache();
	}

	/** 设置背景色函数（通过采样检测变化） */
	setBgFn(bgFn?: (text: string) => string): void {
		this.bgFn = bgFn;
		// Don't invalidate here - we'll detect bgFn changes by sampling output
	}

	private invalidateCache(): void {
		this.cache = undefined;
	}

	private matchCache(width: number, childLines: string[], bgSample: string | undefined): boolean {
		const cache = this.cache;
		return (
			!!cache &&
			cache.width === width &&
			cache.bgSample === bgSample &&
			cache.childLines.length === childLines.length &&
			cache.childLines.every((line, i) => line === childLines[i])
		);
	}

	invalidate(): void {
		this.invalidateCache();
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	render(width: number): string[] {
		if (this.children.length === 0) {
			return [];
		}

		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const leftPad = " ".repeat(this.paddingX);

		// Render all children
		const childLines: string[] = [];
		for (const child of this.children) {
			const lines = child.render(contentWidth);
			for (const line of lines) {
				childLines.push(leftPad + line);
			}
		}

		if (childLines.length === 0) {
			return [];
		}

		// Check if bgFn output changed by sampling
		const bgSample = this.bgFn ? this.bgFn("test") : undefined;

		// Check cache validity
		if (this.matchCache(width, childLines, bgSample)) {
			return this.cache!.lines;
		}

		// Apply background and padding
		const result: string[] = [];

		// Top padding
		for (let i = 0; i < this.paddingY; i++) {
			result.push(this.applyBg("", width));
		}

		// Content
		for (const line of childLines) {
			result.push(this.applyBg(line, width));
		}

		// Bottom padding
		for (let i = 0; i < this.paddingY; i++) {
			result.push(this.applyBg("", width));
		}

		// Update cache
		this.cache = { childLines, width, bgSample, lines: result };

		return result;
	}

	/** 为行应用背景色并填充至指定宽度 */
	private applyBg(line: string, width: number): string {
		const visLen = visibleWidth(line);
		const padNeeded = Math.max(0, width - visLen);
		const padded = line + " ".repeat(padNeeded);

		if (this.bgFn) {
			return applyBackgroundToLine(padded, width, this.bgFn);
		}
		return padded;
	}
}
