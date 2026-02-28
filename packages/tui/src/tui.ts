/**
 * @file TUI 核心实现 - 差异化终端渲染引擎
 *
 * 本文件实现了终端 UI 框架的核心功能，包括：
 * - Component 组件接口定义
 * - Container 容器组件（组合子组件）
 * - TUI 主类（差异化渲染、焦点管理、叠加层系统、硬件光标定位）
 *
 * 渲染机制：
 * TUI 使用差异化渲染策略，只更新变化的行，减少终端闪烁和带宽使用。
 * 支持同步输出（Synchronized Output）以避免撕裂。
 * 叠加层（Overlay）系统允许在基础内容之上渲染模态组件。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isKeyRelease, matchesKey } from "./keys.js";
import type { Terminal } from "./terminal.js";
import { getCapabilities, isImageLine, setCellDimensions } from "./terminal-image.js";
import { extractSegments, sliceByColumn, sliceWithWidth, visibleWidth } from "./utils.js";

/**
 * 组件接口 - 所有 TUI 组件必须实现此接口
 */
export interface Component {
	/**
	 * 将组件渲染为指定视口宽度的行数组
	 * @param width - 当前视口宽度（终端列数）
	 * @returns 字符串数组，每个元素代表一行输出
	 */
	render(width: number): string[];

	/**
	 * 可选的键盘输入处理器，当组件获得焦点时被调用
	 */
	handleInput?(data: string): void;

	/**
	 * 是否接收按键释放事件（Kitty 协议特性）。
	 * 默认为 false - 释放事件会被过滤掉。
	 */
	wantsKeyRelease?: boolean;

	/**
	 * 使缓存的渲染状态失效。
	 * 在主题更改或组件需要从头重新渲染时调用。
	 */
	invalidate(): void;
}

/** 输入监听器的返回结果类型：consume 为 true 时消费输入，data 可用于修改输入数据 */
type InputListenerResult = { consume?: boolean; data?: string } | undefined;
/** 输入监听器函数类型，用于拦截和处理原始键盘输入 */
type InputListener = (data: string) => InputListenerResult;

/**
 * 可聚焦组件接口 - 用于接收焦点和显示硬件光标。
 * 当组件获得焦点时，应在渲染输出中的光标位置发出 CURSOR_MARKER。
 * TUI 会找到此标记并定位硬件光标，以便输入法候选窗口正确显示。
 */
export interface Focusable {
	/** 由 TUI 在焦点变化时设置。当为 true 时，组件应在渲染中发出 CURSOR_MARKER。 */
	focused: boolean;
}

/**
 * 类型守卫：检查组件是否实现了 Focusable 接口
 */
export function isFocusable(component: Component | null): component is Component & Focusable {
	return component !== null && "focused" in component;
}

/**
 * 光标位置标记 - APC（应用程序命令）转义序列。
 * 这是一个零宽度的转义序列，终端会忽略它。
 * 组件在获得焦点时会在光标位置发出此标记。
 * TUI 会找到并移除此标记，然后将硬件光标定位到该位置。
 */
export const CURSOR_MARKER = "\x1b_pi:c\x07";

export { visibleWidth };

/**
 * 叠加层的锚点位置类型
 */
export type OverlayAnchor =
	| "center"
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right"
	| "top-center"
	| "bottom-center"
	| "left-center"
	| "right-center";

/**
 * 叠加层的边距配置
 */
export interface OverlayMargin {
	top?: number;
	right?: number;
	bottom?: number;
	left?: number;
}

/** 尺寸值类型：可以是绝对值（数字）或百分比（如 "50%"） */
export type SizeValue = number | `${number}%`;

/** 将 SizeValue 解析为绝对值（基于参考尺寸） */
function parseSizeValue(value: SizeValue | undefined, referenceSize: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return value;
	// Parse percentage string like "50%"
	const match = value.match(/^(\d+(?:\.\d+)?)%$/);
	if (match) {
		return Math.floor((referenceSize * parseFloat(match[1])) / 100);
	}
	return undefined;
}

/**
 * 叠加层的定位和尺寸选项。
 * 值可以是绝对数字或百分比字符串（如 "50%"）。
 */
export interface OverlayOptions {
	// === 尺寸 ===
	/** 宽度（列数），或终端宽度的百分比（如 "50%"） */
	width?: SizeValue;
	/** 最小宽度（列数） */
	minWidth?: number;
	/** 最大高度（行数），或终端高度的百分比（如 "50%"） */
	maxHeight?: SizeValue;

	// === 基于锚点的定位 ===
	/** 定位锚点（默认：'center'） */
	anchor?: OverlayAnchor;
	/** 相对锚点的水平偏移（正数向右） */
	offsetX?: number;
	/** 相对锚点的垂直偏移（正数向下） */
	offsetY?: number;

	// === 百分比或绝对定位 ===
	/** 行位置：绝对数字或百分比（如 "25%" 表示距顶部 25%） */
	row?: SizeValue;
	/** 列位置：绝对数字或百分比（如 "50%" 表示水平居中） */
	col?: SizeValue;

	// === 终端边缘的边距 ===
	/** 距终端边缘的边距。数字表示四边等距。 */
	margin?: OverlayMargin | number;

	// === 可见性控制 ===
	/**
	 * 基于终端尺寸控制叠加层可见性。
	 * 如果提供，叠加层仅在此函数返回 true 时渲染。
	 * 每次渲染周期都会使用当前终端尺寸调用此函数。
	 */
	visible?: (termWidth: number, termHeight: number) => boolean;
}

/**
 * showOverlay 返回的句柄，用于控制叠加层
 */
export interface OverlayHandle {
	/** 永久移除叠加层（不可再次显示） */
	hide(): void;
	/** 临时隐藏或显示叠加层 */
	setHidden(hidden: boolean): void;
	/** 检查叠加层是否被临时隐藏 */
	isHidden(): boolean;
}

/**
 * 容器组件 - 可以包含多个子组件的组合组件
 */
export class Container implements Component {
	/** 子组件列表 */
	children: Component[] = [];

	/** 添加子组件 */
	addChild(component: Component): void {
		this.children.push(component);
	}

	/** 移除子组件 */
	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
		}
	}

	/** 清空所有子组件 */
	clear(): void {
		this.children = [];
	}

	invalidate(): void {
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			lines.push(...child.render(width));
		}
		return lines;
	}
}

/**
 * TUI 主类 - 管理终端 UI 的差异化渲染引擎
 *
 * 核心职责：
 * - 差异化渲染：只更新变化的行，减少终端闪烁
 * - 焦点管理：跟踪和切换组件焦点
 * - 叠加层系统：支持模态叠加层的堆栈管理
 * - 输入路由：将键盘输入分发给聚焦的组件
 * - 硬件光标定位：为 IME 输入法定位光标
 * - 终端单元格尺寸查询：用于图像渲染
 */
export class TUI extends Container {
	/** 终端接口实例 */
	public terminal: Terminal;
	/** 上一次渲染的行内容（用于差异比较） */
	private previousLines: string[] = [];
	/** 上一次渲染时的终端宽度 */
	private previousWidth = 0;
	/** 当前获得焦点的组件 */
	private focusedComponent: Component | null = null;
	/** 输入监听器集合（拦截/修改原始输入） */
	private inputListeners = new Set<InputListener>();

	/** 调试键（Shift+Ctrl+D）的全局回调。在输入转发给聚焦组件之前调用。 */
	public onDebug?: () => void;
	/** 是否已请求渲染（防止同一 tick 内重复渲染） */
	private renderRequested = false;
	/** 逻辑光标行（渲染内容的末尾位置） */
	private cursorRow = 0;
	/** 实际终端光标行（可能因 IME 定位而不同） */
	private hardwareCursorRow = 0;
	/** 输入缓冲区（用于解析终端响应） */
	private inputBuffer = "";
	/** 是否正在等待单元格尺寸查询响应 */
	private cellSizeQueryPending = false;
	/** 是否显示硬件光标（用于 IME 候选窗口定位） */
	private showHardwareCursor = process.env.PI_HARDWARE_CURSOR === "1";
	/** 内容缩小时是否清除空行（默认关闭） */
	private clearOnShrink = process.env.PI_CLEAR_ON_SHRINK === "1";
	/** 终端工作区域的最大行数（曾经渲染过的最多行数） */
	private maxLinesRendered = 0;
	/** 上一次视口顶部位置（用于调整尺寸时感知光标移动） */
	private previousViewportTop = 0;
	/** 完整重绘计数 */
	private fullRedrawCount = 0;
	/** 是否已停止 */
	private stopped = false;

	// 叠加层堆栈 - 在基础内容之上渲染的模态组件
	private overlayStack: {
		component: Component; // 叠加层组件
		options?: OverlayOptions; // 定位和尺寸选项
		preFocus: Component | null; // 显示叠加层前的焦点组件（用于恢复）
		hidden: boolean; // 是否临时隐藏
	}[] = [];

	constructor(terminal: Terminal, showHardwareCursor?: boolean) {
		super();
		this.terminal = terminal;
		if (showHardwareCursor !== undefined) {
			this.showHardwareCursor = showHardwareCursor;
		}
	}

	/** 获取完整重绘次数（用于性能监控） */
	get fullRedraws(): number {
		return this.fullRedrawCount;
	}

	/** 获取是否显示硬件光标 */
	getShowHardwareCursor(): boolean {
		return this.showHardwareCursor;
	}

	/** 设置是否显示硬件光标 */
	setShowHardwareCursor(enabled: boolean): void {
		if (this.showHardwareCursor === enabled) return;
		this.showHardwareCursor = enabled;
		if (!enabled) {
			this.terminal.hideCursor();
		}
		this.requestRender();
	}

	/** 获取内容缩小时是否清除空行 */
	getClearOnShrink(): boolean {
		return this.clearOnShrink;
	}

	/**
	 * 设置内容缩小时是否触发完整重绘。
	 * 当为 true 时，内容缩小后会清除空行。
	 * 当为 false 时，空行保留不清除（减少慢速终端的重绘次数）。
	 */
	setClearOnShrink(enabled: boolean): void {
		this.clearOnShrink = enabled;
	}

	/** 设置焦点组件，同时更新旧组件和新组件的 focused 标志 */
	setFocus(component: Component | null): void {
		// 清除旧组件的焦点标志
		if (isFocusable(this.focusedComponent)) {
			this.focusedComponent.focused = false;
		}

		this.focusedComponent = component;

		// Set focused flag on new component
		if (isFocusable(component)) {
			component.focused = true;
		}
	}

	/**
	 * 显示叠加层组件，支持可配置的定位和尺寸。
	 * 返回一个句柄用于控制叠加层的可见性。
	 */
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
		const entry = { component, options, preFocus: this.focusedComponent, hidden: false };
		this.overlayStack.push(entry);
		// Only focus if overlay is actually visible
		if (this.isOverlayVisible(entry)) {
			this.setFocus(component);
		}
		this.terminal.hideCursor();
		this.requestRender();

		// Return handle for controlling this overlay
		return {
			hide: () => {
				const index = this.overlayStack.indexOf(entry);
				if (index !== -1) {
					this.overlayStack.splice(index, 1);
					// Restore focus if this overlay had focus
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
					if (this.overlayStack.length === 0) this.terminal.hideCursor();
					this.requestRender();
				}
			},
			setHidden: (hidden: boolean) => {
				if (entry.hidden === hidden) return;
				entry.hidden = hidden;
				// Update focus when hiding/showing
				if (hidden) {
					// If this overlay had focus, move focus to next visible or preFocus
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
				} else {
					// Restore focus to this overlay when showing (if it's actually visible)
					if (this.isOverlayVisible(entry)) {
						this.setFocus(component);
					}
				}
				this.requestRender();
			},
			isHidden: () => entry.hidden,
		};
	}

	/** 隐藏最顶层的叠加层并恢复之前的焦点 */
	hideOverlay(): void {
		const overlay = this.overlayStack.pop();
		if (!overlay) return;
		// Find topmost visible overlay, or fall back to preFocus
		const topVisible = this.getTopmostVisibleOverlay();
		this.setFocus(topVisible?.component ?? overlay.preFocus);
		if (this.overlayStack.length === 0) this.terminal.hideCursor();
		this.requestRender();
	}

	/** 检查是否有任何可见的叠加层 */
	hasOverlay(): boolean {
		return this.overlayStack.some((o) => this.isOverlayVisible(o));
	}

	/** 检查叠加层条目当前是否可见 */
	private isOverlayVisible(entry: (typeof this.overlayStack)[number]): boolean {
		if (entry.hidden) return false;
		if (entry.options?.visible) {
			return entry.options.visible(this.terminal.columns, this.terminal.rows);
		}
		return true;
	}

	/** 查找最顶层的可见叠加层（如果有） */
	private getTopmostVisibleOverlay(): (typeof this.overlayStack)[number] | undefined {
		for (let i = this.overlayStack.length - 1; i >= 0; i--) {
			if (this.isOverlayVisible(this.overlayStack[i])) {
				return this.overlayStack[i];
			}
		}
		return undefined;
	}

	override invalidate(): void {
		super.invalidate();
		for (const overlay of this.overlayStack) overlay.component.invalidate?.();
	}

	/** 启动 TUI - 开始监听输入和调整大小事件，隐藏光标并触发首次渲染 */
	start(): void {
		this.stopped = false;
		this.terminal.start(
			(data) => this.handleInput(data),
			() => this.requestRender(),
		);
		this.terminal.hideCursor();
		this.queryCellSize();
		this.requestRender();
	}

	/** 添加输入监听器，返回取消注册的函数 */
	addInputListener(listener: InputListener): () => void {
		this.inputListeners.add(listener);
		return () => {
			this.inputListeners.delete(listener);
		};
	}

	/** 移除输入监听器 */
	removeInputListener(listener: InputListener): void {
		this.inputListeners.delete(listener);
	}

	/** 查询终端单元格的像素尺寸（仅在支持图像的终端上执行） */
	private queryCellSize(): void {
		// 仅在终端支持图像时查询（单元格尺寸仅用于图像渲染）
		if (!getCapabilities().images) {
			return;
		}
		// 查询终端单元格像素尺寸：CSI 16 t
		// 响应格式：CSI 6 ; height ; width t
		this.cellSizeQueryPending = true;
		this.terminal.write("\x1b[16t");
	}

	/** 停止 TUI - 将光标移到内容末尾，恢复光标可见性，停止终端 */
	stop(): void {
		this.stopped = true;
		// 将光标移到内容末尾，防止退出时覆盖或产生残影
		if (this.previousLines.length > 0) {
			const targetRow = this.previousLines.length; // Line after the last content
			const lineDiff = targetRow - this.hardwareCursorRow;
			if (lineDiff > 0) {
				this.terminal.write(`\x1b[${lineDiff}B`);
			} else if (lineDiff < 0) {
				this.terminal.write(`\x1b[${-lineDiff}A`);
			}
			this.terminal.write("\r\n");
		}

		this.terminal.showCursor();
		this.terminal.stop();
	}

	/** 请求渲染。force=true 时强制完整重绘（清除所有缓存状态） */
	requestRender(force = false): void {
		if (force) {
			this.previousLines = [];
			this.previousWidth = -1; // -1 triggers widthChanged, forcing a full clear
			this.cursorRow = 0;
			this.hardwareCursorRow = 0;
			this.maxLinesRendered = 0;
			this.previousViewportTop = 0;
		}
		if (this.renderRequested) return;
		this.renderRequested = true;
		process.nextTick(() => {
			this.renderRequested = false;
			this.doRender();
		});
	}

	/** 处理键盘输入：先经过监听器链，然后路由到聚焦的组件 */
	private handleInput(data: string): void {
		if (this.inputListeners.size > 0) {
			let current = data;
			for (const listener of this.inputListeners) {
				const result = listener(current);
				if (result?.consume) {
					return;
				}
				if (result?.data !== undefined) {
					current = result.data;
				}
			}
			if (current.length === 0) {
				return;
			}
			data = current;
		}

		// If we're waiting for cell size response, buffer input and parse
		if (this.cellSizeQueryPending) {
			this.inputBuffer += data;
			const filtered = this.parseCellSizeResponse();
			if (filtered.length === 0) return;
			data = filtered;
		}

		// Global debug key handler (Shift+Ctrl+D)
		if (matchesKey(data, "shift+ctrl+d") && this.onDebug) {
			this.onDebug();
			return;
		}

		// If focused component is an overlay, verify it's still visible
		// (visibility can change due to terminal resize or visible() callback)
		const focusedOverlay = this.overlayStack.find((o) => o.component === this.focusedComponent);
		if (focusedOverlay && !this.isOverlayVisible(focusedOverlay)) {
			// Focused overlay is no longer visible, redirect to topmost visible overlay
			const topVisible = this.getTopmostVisibleOverlay();
			if (topVisible) {
				this.setFocus(topVisible.component);
			} else {
				// No visible overlays, restore to preFocus
				this.setFocus(focusedOverlay.preFocus);
			}
		}

		// Pass input to focused component (including Ctrl+C)
		// The focused component can decide how to handle Ctrl+C
		if (this.focusedComponent?.handleInput) {
			// Filter out key release events unless component opts in
			if (isKeyRelease(data) && !this.focusedComponent.wantsKeyRelease) {
				return;
			}
			this.focusedComponent.handleInput(data);
			this.requestRender();
		}
	}

	/** 从输入缓冲区中解析终端单元格尺寸响应，返回过滤后的用户输入 */
	private parseCellSizeResponse(): string {
		// 响应格式：ESC [ 6 ; height ; width t
		// 匹配响应模式
		const responsePattern = /\x1b\[6;(\d+);(\d+)t/;
		const match = this.inputBuffer.match(responsePattern);

		if (match) {
			const heightPx = parseInt(match[1], 10);
			const widthPx = parseInt(match[2], 10);

			if (heightPx > 0 && widthPx > 0) {
				setCellDimensions({ widthPx, heightPx });
				// Invalidate all components so images re-render with correct dimensions
				this.invalidate();
				this.requestRender();
			}

			// Remove the response from buffer
			this.inputBuffer = this.inputBuffer.replace(responsePattern, "");
			this.cellSizeQueryPending = false;
		}

		// Check if we have a partial cell size response starting (wait for more data)
		// Patterns that could be incomplete cell size response: \x1b, \x1b[, \x1b[6, \x1b[6;...(no t yet)
		const partialCellSizePattern = /\x1b(\[6?;?[\d;]*)?$/;
		if (partialCellSizePattern.test(this.inputBuffer)) {
			// Check if it's actually a complete different escape sequence (ends with a letter)
			// Cell size response ends with 't', Kitty keyboard ends with 'u', arrows end with A-D, etc.
			const lastChar = this.inputBuffer[this.inputBuffer.length - 1];
			if (!/[a-zA-Z~]/.test(lastChar)) {
				// Doesn't end with a terminator, might be incomplete - wait for more
				return "";
			}
		}

		// No cell size response found, return buffered data as user input
		const result = this.inputBuffer;
		this.inputBuffer = "";
		this.cellSizeQueryPending = false; // Give up waiting
		return result;
	}

	/**
	 * 根据选项解析叠加层的布局。
	 * 返回 { width, row, col, maxHeight } 用于渲染。
	 */
	private resolveOverlayLayout(
		options: OverlayOptions | undefined,
		overlayHeight: number,
		termWidth: number,
		termHeight: number,
	): { width: number; row: number; col: number; maxHeight: number | undefined } {
		const opt = options ?? {};

		// Parse margin (clamp to non-negative)
		const margin =
			typeof opt.margin === "number"
				? { top: opt.margin, right: opt.margin, bottom: opt.margin, left: opt.margin }
				: (opt.margin ?? {});
		const marginTop = Math.max(0, margin.top ?? 0);
		const marginRight = Math.max(0, margin.right ?? 0);
		const marginBottom = Math.max(0, margin.bottom ?? 0);
		const marginLeft = Math.max(0, margin.left ?? 0);

		// Available space after margins
		const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
		const availHeight = Math.max(1, termHeight - marginTop - marginBottom);

		// === Resolve width ===
		let width = parseSizeValue(opt.width, termWidth) ?? Math.min(80, availWidth);
		// Apply minWidth
		if (opt.minWidth !== undefined) {
			width = Math.max(width, opt.minWidth);
		}
		// Clamp to available space
		width = Math.max(1, Math.min(width, availWidth));

		// === Resolve maxHeight ===
		let maxHeight = parseSizeValue(opt.maxHeight, termHeight);
		// Clamp to available space
		if (maxHeight !== undefined) {
			maxHeight = Math.max(1, Math.min(maxHeight, availHeight));
		}

		// Effective overlay height (may be clamped by maxHeight)
		const effectiveHeight = maxHeight !== undefined ? Math.min(overlayHeight, maxHeight) : overlayHeight;

		// === Resolve position ===
		let row: number;
		let col: number;

		if (opt.row !== undefined) {
			if (typeof opt.row === "string") {
				// Percentage: 0% = top, 100% = bottom (overlay stays within bounds)
				const match = opt.row.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxRow = Math.max(0, availHeight - effectiveHeight);
					const percent = parseFloat(match[1]) / 100;
					row = marginTop + Math.floor(maxRow * percent);
				} else {
					// Invalid format, fall back to center
					row = this.resolveAnchorRow("center", effectiveHeight, availHeight, marginTop);
				}
			} else {
				// Absolute row position
				row = opt.row;
			}
		} else {
			// Anchor-based (default: center)
			const anchor = opt.anchor ?? "center";
			row = this.resolveAnchorRow(anchor, effectiveHeight, availHeight, marginTop);
		}

		if (opt.col !== undefined) {
			if (typeof opt.col === "string") {
				// Percentage: 0% = left, 100% = right (overlay stays within bounds)
				const match = opt.col.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxCol = Math.max(0, availWidth - width);
					const percent = parseFloat(match[1]) / 100;
					col = marginLeft + Math.floor(maxCol * percent);
				} else {
					// Invalid format, fall back to center
					col = this.resolveAnchorCol("center", width, availWidth, marginLeft);
				}
			} else {
				// Absolute column position
				col = opt.col;
			}
		} else {
			// Anchor-based (default: center)
			const anchor = opt.anchor ?? "center";
			col = this.resolveAnchorCol(anchor, width, availWidth, marginLeft);
		}

		// Apply offsets
		if (opt.offsetY !== undefined) row += opt.offsetY;
		if (opt.offsetX !== undefined) col += opt.offsetX;

		// Clamp to terminal bounds (respecting margins)
		row = Math.max(marginTop, Math.min(row, termHeight - marginBottom - effectiveHeight));
		col = Math.max(marginLeft, Math.min(col, termWidth - marginRight - width));

		return { width, row, col, maxHeight };
	}

	private resolveAnchorRow(anchor: OverlayAnchor, height: number, availHeight: number, marginTop: number): number {
		switch (anchor) {
			case "top-left":
			case "top-center":
			case "top-right":
				return marginTop;
			case "bottom-left":
			case "bottom-center":
			case "bottom-right":
				return marginTop + availHeight - height;
			case "left-center":
			case "center":
			case "right-center":
				return marginTop + Math.floor((availHeight - height) / 2);
		}
	}

	private resolveAnchorCol(anchor: OverlayAnchor, width: number, availWidth: number, marginLeft: number): number {
		switch (anchor) {
			case "top-left":
			case "left-center":
			case "bottom-left":
				return marginLeft;
			case "top-right":
			case "right-center":
			case "bottom-right":
				return marginLeft + availWidth - width;
			case "top-center":
			case "center":
			case "bottom-center":
				return marginLeft + Math.floor((availWidth - width) / 2);
		}
	}

	/** 将所有叠加层合成到内容行中（按堆栈顺序，后入的在上层） */
	private compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[] {
		if (this.overlayStack.length === 0) return lines;
		const result = [...lines];

		// Pre-render all visible overlays and calculate positions
		const rendered: { overlayLines: string[]; row: number; col: number; w: number }[] = [];
		let minLinesNeeded = result.length;

		for (const entry of this.overlayStack) {
			// Skip invisible overlays (hidden or visible() returns false)
			if (!this.isOverlayVisible(entry)) continue;

			const { component, options } = entry;

			// Get layout with height=0 first to determine width and maxHeight
			// (width and maxHeight don't depend on overlay height)
			const { width, maxHeight } = this.resolveOverlayLayout(options, 0, termWidth, termHeight);

			// Render component at calculated width
			let overlayLines = component.render(width);

			// Apply maxHeight if specified
			if (maxHeight !== undefined && overlayLines.length > maxHeight) {
				overlayLines = overlayLines.slice(0, maxHeight);
			}

			// Get final row/col with actual overlay height
			const { row, col } = this.resolveOverlayLayout(options, overlayLines.length, termWidth, termHeight);

			rendered.push({ overlayLines, row, col, w: width });
			minLinesNeeded = Math.max(minLinesNeeded, row + overlayLines.length);
		}

		// Ensure result covers the terminal working area to keep overlay positioning stable across resizes.
		// maxLinesRendered can exceed current content length after a shrink; pad to keep viewportStart consistent.
		const workingHeight = Math.max(this.maxLinesRendered, minLinesNeeded);

		// Extend result with empty lines if content is too short for overlay placement or working area
		while (result.length < workingHeight) {
			result.push("");
		}

		const viewportStart = Math.max(0, workingHeight - termHeight);

		// Track which lines were modified for final verification
		const modifiedLines = new Set<number>();

		// Composite each overlay
		for (const { overlayLines, row, col, w } of rendered) {
			for (let i = 0; i < overlayLines.length; i++) {
				const idx = viewportStart + row + i;
				if (idx >= 0 && idx < result.length) {
					// Defensive: truncate overlay line to declared width before compositing
					// (components should already respect width, but this ensures it)
					const truncatedOverlayLine =
						visibleWidth(overlayLines[i]) > w ? sliceByColumn(overlayLines[i], 0, w, true) : overlayLines[i];
					result[idx] = this.compositeLineAt(result[idx], truncatedOverlayLine, col, w, termWidth);
					modifiedLines.add(idx);
				}
			}
		}

		// Final verification: ensure no composited line exceeds terminal width
		// This is a belt-and-suspenders safeguard - compositeLineAt should already
		// guarantee this, but we verify here to prevent crashes from any edge cases
		// Only check lines that were actually modified (optimization)
		for (const idx of modifiedLines) {
			const lineWidth = visibleWidth(result[idx]);
			if (lineWidth > termWidth) {
				result[idx] = sliceByColumn(result[idx], 0, termWidth, true);
			}
		}

		return result;
	}

	private static readonly SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";

	private applyLineResets(lines: string[]): string[] {
		const reset = TUI.SEGMENT_RESET;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!isImageLine(line)) {
				lines[i] = line + reset;
			}
		}
		return lines;
	}

	/** 在指定列位置将叠加层内容拼接到基础行中（单次遍历优化） */
	private compositeLineAt(
		baseLine: string,
		overlayLine: string,
		startCol: number,
		overlayWidth: number,
		totalWidth: number,
	): string {
		if (isImageLine(baseLine)) return baseLine;

		// Single pass through baseLine extracts both before and after segments
		const afterStart = startCol + overlayWidth;
		const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);

		// Extract overlay with width tracking (strict=true to exclude wide chars at boundary)
		const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);

		// Pad segments to target widths
		const beforePad = Math.max(0, startCol - base.beforeWidth);
		const overlayPad = Math.max(0, overlayWidth - overlay.width);
		const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
		const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
		const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
		const afterPad = Math.max(0, afterTarget - base.afterWidth);

		// Compose result
		const r = TUI.SEGMENT_RESET;
		const result =
			base.before +
			" ".repeat(beforePad) +
			r +
			overlay.text +
			" ".repeat(overlayPad) +
			r +
			base.after +
			" ".repeat(afterPad);

		// CRITICAL: Always verify and truncate to terminal width.
		// This is the final safeguard against width overflow which would crash the TUI.
		// Width tracking can drift from actual visible width due to:
		// - Complex ANSI/OSC sequences (hyperlinks, colors)
		// - Wide characters at segment boundaries
		// - Edge cases in segment extraction
		const resultWidth = visibleWidth(result);
		if (resultWidth <= totalWidth) {
			return result;
		}
		// Truncate with strict=true to ensure we don't exceed totalWidth
		return sliceByColumn(result, 0, totalWidth, true);
	}

	/**
	 * 从渲染行中查找并提取光标位置。
	 * 搜索 CURSOR_MARKER，计算其位置，并从输出中移除标记。
	 * 仅扫描底部终端高度的行（可见视口）。
	 * @param lines - 要搜索的渲染行
	 * @param height - 终端高度（可见视口大小）
	 * @returns 光标位置 { row, col }，如果未找到标记则返回 null
	 */
	private extractCursorPosition(lines: string[], height: number): { row: number; col: number } | null {
		// Only scan the bottom `height` lines (visible viewport)
		const viewportTop = Math.max(0, lines.length - height);
		for (let row = lines.length - 1; row >= viewportTop; row--) {
			const line = lines[row];
			const markerIndex = line.indexOf(CURSOR_MARKER);
			if (markerIndex !== -1) {
				// Calculate visual column (width of text before marker)
				const beforeMarker = line.slice(0, markerIndex);
				const col = visibleWidth(beforeMarker);

				// Strip marker from the line
				lines[row] = line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length);

				return { row, col };
			}
		}
		return null;
	}

	/** 执行实际的差异化渲染 - 比较新旧行，只更新变化的部分 */
	private doRender(): void {
		if (this.stopped) return;
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		let viewportTop = Math.max(0, this.maxLinesRendered - height);
		let prevViewportTop = this.previousViewportTop;
		let hardwareCursorRow = this.hardwareCursorRow;
		const computeLineDiff = (targetRow: number): number => {
			const currentScreenRow = hardwareCursorRow - prevViewportTop;
			const targetScreenRow = targetRow - viewportTop;
			return targetScreenRow - currentScreenRow;
		};

		// Render all components to get new lines
		let newLines = this.render(width);

		// Composite overlays into the rendered lines (before differential compare)
		if (this.overlayStack.length > 0) {
			newLines = this.compositeOverlays(newLines, width, height);
		}

		// Extract cursor position before applying line resets (marker must be found first)
		const cursorPos = this.extractCursorPosition(newLines, height);

		newLines = this.applyLineResets(newLines);

		// Width changed - need full re-render (line wrapping changes)
		const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width;

		// Helper to clear scrollback and viewport and render all new lines
		const fullRender = (clear: boolean): void => {
			this.fullRedrawCount += 1;
			let buffer = "\x1b[?2026h"; // Begin synchronized output
			if (clear) buffer += "\x1b[3J\x1b[2J\x1b[H"; // Clear scrollback, screen, and home
			for (let i = 0; i < newLines.length; i++) {
				if (i > 0) buffer += "\r\n";
				buffer += newLines[i];
			}
			buffer += "\x1b[?2026l"; // End synchronized output
			this.terminal.write(buffer);
			this.cursorRow = Math.max(0, newLines.length - 1);
			this.hardwareCursorRow = this.cursorRow;
			// Reset max lines when clearing, otherwise track growth
			if (clear) {
				this.maxLinesRendered = newLines.length;
			} else {
				this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
			}
			this.previousViewportTop = Math.max(0, this.maxLinesRendered - height);
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousWidth = width;
		};

		const debugRedraw = process.env.PI_DEBUG_REDRAW === "1";
		const logRedraw = (reason: string): void => {
			if (!debugRedraw) return;
			const logPath = path.join(os.homedir(), ".pi", "agent", "pi-debug.log");
			const msg = `[${new Date().toISOString()}] fullRender: ${reason} (prev=${this.previousLines.length}, new=${newLines.length}, height=${height})\n`;
			fs.appendFileSync(logPath, msg);
		};

		// First render - just output everything without clearing (assumes clean screen)
		if (this.previousLines.length === 0 && !widthChanged) {
			logRedraw("first render");
			fullRender(false);
			return;
		}

		// Width changed - full re-render (line wrapping changes)
		if (widthChanged) {
			logRedraw(`width changed (${this.previousWidth} -> ${width})`);
			fullRender(true);
			return;
		}

		// Content shrunk below the working area and no overlays - re-render to clear empty rows
		// (overlays need the padding, so only do this when no overlays are active)
		// Configurable via setClearOnShrink() or PI_CLEAR_ON_SHRINK=0 env var
		if (this.clearOnShrink && newLines.length < this.maxLinesRendered && this.overlayStack.length === 0) {
			logRedraw(`clearOnShrink (maxLinesRendered=${this.maxLinesRendered})`);
			fullRender(true);
			return;
		}

		// Find first and last changed lines
		let firstChanged = -1;
		let lastChanged = -1;
		const maxLines = Math.max(newLines.length, this.previousLines.length);
		for (let i = 0; i < maxLines; i++) {
			const oldLine = i < this.previousLines.length ? this.previousLines[i] : "";
			const newLine = i < newLines.length ? newLines[i] : "";

			if (oldLine !== newLine) {
				if (firstChanged === -1) {
					firstChanged = i;
				}
				lastChanged = i;
			}
		}
		const appendedLines = newLines.length > this.previousLines.length;
		if (appendedLines) {
			if (firstChanged === -1) {
				firstChanged = this.previousLines.length;
			}
			lastChanged = newLines.length - 1;
		}
		const appendStart = appendedLines && firstChanged === this.previousLines.length && firstChanged > 0;

		// No changes - but still need to update hardware cursor position if it moved
		if (firstChanged === -1) {
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousViewportTop = Math.max(0, this.maxLinesRendered - height);
			return;
		}

		// All changes are in deleted lines (nothing to render, just clear)
		if (firstChanged >= newLines.length) {
			if (this.previousLines.length > newLines.length) {
				let buffer = "\x1b[?2026h";
				// Move to end of new content (clamp to 0 for empty content)
				const targetRow = Math.max(0, newLines.length - 1);
				const lineDiff = computeLineDiff(targetRow);
				if (lineDiff > 0) buffer += `\x1b[${lineDiff}B`;
				else if (lineDiff < 0) buffer += `\x1b[${-lineDiff}A`;
				buffer += "\r";
				// Clear extra lines without scrolling
				const extraLines = this.previousLines.length - newLines.length;
				if (extraLines > height) {
					logRedraw(`extraLines > height (${extraLines} > ${height})`);
					fullRender(true);
					return;
				}
				if (extraLines > 0) {
					buffer += "\x1b[1B";
				}
				for (let i = 0; i < extraLines; i++) {
					buffer += "\r\x1b[2K";
					if (i < extraLines - 1) buffer += "\x1b[1B";
				}
				if (extraLines > 0) {
					buffer += `\x1b[${extraLines}A`;
				}
				buffer += "\x1b[?2026l";
				this.terminal.write(buffer);
				this.cursorRow = targetRow;
				this.hardwareCursorRow = targetRow;
			}
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousWidth = width;
			this.previousViewportTop = Math.max(0, this.maxLinesRendered - height);
			return;
		}

		// Check if firstChanged is above what was previously visible
		// Use previousLines.length (not maxLinesRendered) to avoid false positives after content shrinks
		const previousContentViewportTop = Math.max(0, this.previousLines.length - height);
		if (firstChanged < previousContentViewportTop) {
			// First change is above previous viewport - need full re-render
			logRedraw(`firstChanged < viewportTop (${firstChanged} < ${previousContentViewportTop})`);
			fullRender(true);
			return;
		}

		// Render from first changed line to end
		// Build buffer with all updates wrapped in synchronized output
		let buffer = "\x1b[?2026h"; // Begin synchronized output
		const prevViewportBottom = prevViewportTop + height - 1;
		const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged;
		if (moveTargetRow > prevViewportBottom) {
			const currentScreenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - prevViewportTop));
			const moveToBottom = height - 1 - currentScreenRow;
			if (moveToBottom > 0) {
				buffer += `\x1b[${moveToBottom}B`;
			}
			const scroll = moveTargetRow - prevViewportBottom;
			buffer += "\r\n".repeat(scroll);
			prevViewportTop += scroll;
			viewportTop += scroll;
			hardwareCursorRow = moveTargetRow;
		}

		// Move cursor to first changed line (use hardwareCursorRow for actual position)
		const lineDiff = computeLineDiff(moveTargetRow);
		if (lineDiff > 0) {
			buffer += `\x1b[${lineDiff}B`; // Move down
		} else if (lineDiff < 0) {
			buffer += `\x1b[${-lineDiff}A`; // Move up
		}

		buffer += appendStart ? "\r\n" : "\r"; // Move to column 0

		// Only render changed lines (firstChanged to lastChanged), not all lines to end
		// This reduces flicker when only a single line changes (e.g., spinner animation)
		const renderEnd = Math.min(lastChanged, newLines.length - 1);
		for (let i = firstChanged; i <= renderEnd; i++) {
			if (i > firstChanged) buffer += "\r\n";
			buffer += "\x1b[2K"; // Clear current line
			const line = newLines[i];
			const isImage = isImageLine(line);
			if (!isImage && visibleWidth(line) > width) {
				// Log all lines to crash file for debugging
				const crashLogPath = path.join(os.homedir(), ".pi", "agent", "pi-crash.log");
				const crashData = [
					`Crash at ${new Date().toISOString()}`,
					`Terminal width: ${width}`,
					`Line ${i} visible width: ${visibleWidth(line)}`,
					"",
					"=== All rendered lines ===",
					...newLines.map((l, idx) => `[${idx}] (w=${visibleWidth(l)}) ${l}`),
					"",
				].join("\n");
				fs.mkdirSync(path.dirname(crashLogPath), { recursive: true });
				fs.writeFileSync(crashLogPath, crashData);

				// Clean up terminal state before throwing
				this.stop();

				const errorMsg = [
					`Rendered line ${i} exceeds terminal width (${visibleWidth(line)} > ${width}).`,
					"",
					"This is likely caused by a custom TUI component not truncating its output.",
					"Use visibleWidth() to measure and truncateToWidth() to truncate lines.",
					"",
					`Debug log written to: ${crashLogPath}`,
				].join("\n");
				throw new Error(errorMsg);
			}
			buffer += line;
		}

		// Track where cursor ended up after rendering
		let finalCursorRow = renderEnd;

		// If we had more lines before, clear them and move cursor back
		if (this.previousLines.length > newLines.length) {
			// Move to end of new content first if we stopped before it
			if (renderEnd < newLines.length - 1) {
				const moveDown = newLines.length - 1 - renderEnd;
				buffer += `\x1b[${moveDown}B`;
				finalCursorRow = newLines.length - 1;
			}
			const extraLines = this.previousLines.length - newLines.length;
			for (let i = newLines.length; i < this.previousLines.length; i++) {
				buffer += "\r\n\x1b[2K";
			}
			// Move cursor back to end of new content
			buffer += `\x1b[${extraLines}A`;
		}

		buffer += "\x1b[?2026l"; // End synchronized output

		if (process.env.PI_TUI_DEBUG === "1") {
			const debugDir = "/tmp/tui";
			fs.mkdirSync(debugDir, { recursive: true });
			const debugPath = path.join(debugDir, `render-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
			const debugData = [
				`firstChanged: ${firstChanged}`,
				`viewportTop: ${viewportTop}`,
				`cursorRow: ${this.cursorRow}`,
				`height: ${height}`,
				`lineDiff: ${lineDiff}`,
				`hardwareCursorRow: ${hardwareCursorRow}`,
				`renderEnd: ${renderEnd}`,
				`finalCursorRow: ${finalCursorRow}`,
				`cursorPos: ${JSON.stringify(cursorPos)}`,
				`newLines.length: ${newLines.length}`,
				`previousLines.length: ${this.previousLines.length}`,
				"",
				"=== newLines ===",
				JSON.stringify(newLines, null, 2),
				"",
				"=== previousLines ===",
				JSON.stringify(this.previousLines, null, 2),
				"",
				"=== buffer ===",
				JSON.stringify(buffer),
			].join("\n");
			fs.writeFileSync(debugPath, debugData);
		}

		// Write entire buffer at once
		this.terminal.write(buffer);

		// Track cursor position for next render
		// cursorRow tracks end of content (for viewport calculation)
		// hardwareCursorRow tracks actual terminal cursor position (for movement)
		this.cursorRow = Math.max(0, newLines.length - 1);
		this.hardwareCursorRow = finalCursorRow;
		// Track terminal's working area (grows but doesn't shrink unless cleared)
		this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
		this.previousViewportTop = Math.max(0, this.maxLinesRendered - height);

		// Position hardware cursor for IME
		this.positionHardwareCursor(cursorPos, newLines.length);

		this.previousLines = newLines;
		this.previousWidth = width;
	}

	/**
	 * 为 IME 候选窗口定位硬件光标。
	 * @param cursorPos 从渲染输出中提取的光标位置，或 null
	 * @param totalLines 渲染的总行数
	 */
	private positionHardwareCursor(cursorPos: { row: number; col: number } | null, totalLines: number): void {
		if (!cursorPos || totalLines <= 0) {
			this.terminal.hideCursor();
			return;
		}

		// Clamp cursor position to valid range
		const targetRow = Math.max(0, Math.min(cursorPos.row, totalLines - 1));
		const targetCol = Math.max(0, cursorPos.col);

		// Move cursor from current position to target
		const rowDelta = targetRow - this.hardwareCursorRow;
		let buffer = "";
		if (rowDelta > 0) {
			buffer += `\x1b[${rowDelta}B`; // Move down
		} else if (rowDelta < 0) {
			buffer += `\x1b[${-rowDelta}A`; // Move up
		}
		// Move to absolute column (1-indexed)
		buffer += `\x1b[${targetCol + 1}G`;

		if (buffer) {
			this.terminal.write(buffer);
		}

		this.hardwareCursorRow = targetRow;
		if (this.showHardwareCursor) {
			this.terminal.showCursor();
		} else {
			this.terminal.hideCursor();
		}
	}
}
