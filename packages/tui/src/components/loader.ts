/**
 * @file 加载动画组件
 *
 * 提供旋转动画的加载指示器，每 80ms 更新一次帧。
 * 继承自 Text 组件，使用 Braille 字符作为动画帧。
 */

import type { TUI } from "../tui.js";
import { Text } from "./text.js";

/**
 * 加载动画组件 - 每 80ms 更新一次旋转动画。
 * 使用 Braille 点阵字符（⠋⠙⠹...）实现旋转效果。
 */
export class Loader extends Text {
	/** 动画帧序列（Braille 点阵字符） */
	private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	/** 当前帧索引 */
	private currentFrame = 0;
	/** 动画定时器句柄 */
	private intervalId: NodeJS.Timeout | null = null;
	/** TUI 实例引用，用于请求重新渲染 */
	private ui: TUI | null = null;

	constructor(
		ui: TUI,
		private spinnerColorFn: (str: string) => string,
		private messageColorFn: (str: string) => string,
		private message: string = "Loading...",
	) {
		super("", 1, 0);
		this.ui = ui;
		this.start();
	}

	render(width: number): string[] {
		return ["", ...super.render(width)];
	}

	/** 启动动画定时器 */
	start() {
		this.updateDisplay();
		this.intervalId = setInterval(() => {
			this.currentFrame = (this.currentFrame + 1) % this.frames.length;
			this.updateDisplay();
		}, 80);
	}

	/** 停止动画定时器 */
	stop() {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	/** 更新显示消息 */
	setMessage(message: string) {
		this.message = message;
		this.updateDisplay();
	}

	/** 更新显示内容（旋转帧 + 消息文本） */
	private updateDisplay() {
		const frame = this.frames[this.currentFrame];
		this.setText(`${this.spinnerColorFn(frame)} ${this.messageColorFn(this.message)}`);
		if (this.ui) {
			this.ui.requestRender();
		}
	}
}
