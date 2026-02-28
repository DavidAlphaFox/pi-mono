/**
 * 动态边框组件。
 *
 * 该文件提供一个根据视口宽度自适应调整的水平分隔线组件，
 * 用于在 TUI 界面中分隔不同区域的内容。
 */

import type { Component } from "@mariozechner/pi-tui";
import { theme } from "../theme/theme.js";

/**
 * 动态边框组件，根据当前视口宽度自动调整边框线的长度。
 *
 * 注意：当通过 jiti 加载的扩展中使用时，全局 `theme` 可能为 undefined，
 * 因为 jiti 会创建独立的模块缓存。在导出给扩展使用的组件中，
 * 请始终传入显式的颜色函数。
 */
export class DynamicBorder implements Component {
	private color: (str: string) => string;

	constructor(color: (str: string) => string = (str) => theme.fg("border", str)) {
		this.color = color;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		return [this.color("─".repeat(Math.max(1, width)))];
	}
}
