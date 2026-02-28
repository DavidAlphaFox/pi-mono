/**
 * @file 可取消的加载动画组件
 *
 * 扩展 Loader 组件，添加 Escape 键取消功能和 AbortSignal 支持。
 * 用于可被用户中断的异步操作。
 */

import { getEditorKeybindings } from "../keybindings.js";
import { Loader } from "./loader.js";

/**
 * 可取消的加载动画组件。
 * 用户按 Escape 键时触发中止信号，可用于取消异步操作。
 *
 * @example
 * const loader = new CancellableLoader(tui, cyan, dim, "Working...");
 * loader.onAbort = () => done(null);
 * doWork(loader.signal).then(done);
 */
export class CancellableLoader extends Loader {
	/** 中止控制器 */
	private abortController = new AbortController();

	/** 用户按 Escape 键时调用的回调 */
	onAbort?: () => void;

	/** 中止信号，用户按 Escape 键时触发中止 */
	get signal(): AbortSignal {
		return this.abortController.signal;
	}

	/** 是否已被中止 */
	get aborted(): boolean {
		return this.abortController.signal.aborted;
	}

	/** 处理用户输入，Escape 键触发取消 */
	handleInput(data: string): void {
		const kb = getEditorKeybindings();
		if (kb.matches(data, "selectCancel")) {
			this.abortController.abort();
			this.onAbort?.();
		}
	}

	/** 销毁组件，停止动画 */
	dispose(): void {
		this.stop();
	}
}
