/**
 * 可复用的倒计时器组件。
 *
 * 该文件提供一个通用的倒计时器类，用于对话框组件中的超时处理。
 * 支持每秒回调更新和到期自动触发。
 */

import type { TUI } from "@mariozechner/pi-tui";

/**
 * 倒计时器类。
 * 创建后立即开始倒计时，每秒触发 onTick 回调，到期时触发 onExpire 回调。
 */
export class CountdownTimer {
	private intervalId: ReturnType<typeof setInterval> | undefined;
	private remainingSeconds: number;

	constructor(
		timeoutMs: number,
		private tui: TUI | undefined,
		private onTick: (seconds: number) => void,
		private onExpire: () => void,
	) {
		this.remainingSeconds = Math.ceil(timeoutMs / 1000);
		this.onTick(this.remainingSeconds);

		this.intervalId = setInterval(() => {
			this.remainingSeconds--;
			this.onTick(this.remainingSeconds);
			this.tui?.requestRender();

			if (this.remainingSeconds <= 0) {
				this.dispose();
				this.onExpire();
			}
		}, 1000);
	}

	dispose(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = undefined;
		}
	}
}
