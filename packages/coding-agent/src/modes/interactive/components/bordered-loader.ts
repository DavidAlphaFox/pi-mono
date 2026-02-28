/**
 * 带边框的加载动画组件。
 *
 * 该文件提供用于扩展 UI 的加载指示器，带有上下边框装饰，
 * 支持可取消和不可取消两种模式。
 */

import { CancellableLoader, Container, Loader, Spacer, Text, type TUI } from "@mariozechner/pi-tui";
import type { Theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { keyHint } from "./keybinding-hints.js";

/**
 * 带边框的加载器组件。
 * 在加载动画上下方添加动态边框，可选择性支持用户取消操作。
 */
export class BorderedLoader extends Container {
	private loader: CancellableLoader | Loader;
	private cancellable: boolean;
	private signalController?: AbortController;

	constructor(tui: TUI, theme: Theme, message: string, options?: { cancellable?: boolean }) {
		super();
		this.cancellable = options?.cancellable ?? true;
		const borderColor = (s: string) => theme.fg("border", s);
		this.addChild(new DynamicBorder(borderColor));
		if (this.cancellable) {
			this.loader = new CancellableLoader(
				tui,
				(s) => theme.fg("accent", s),
				(s) => theme.fg("muted", s),
				message,
			);
		} else {
			this.signalController = new AbortController();
			this.loader = new Loader(
				tui,
				(s) => theme.fg("accent", s),
				(s) => theme.fg("muted", s),
				message,
			);
		}
		this.addChild(this.loader);
		if (this.cancellable) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(keyHint("selectCancel", "cancel"), 1, 0));
		}
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder(borderColor));
	}

	get signal(): AbortSignal {
		if (this.cancellable) {
			return (this.loader as CancellableLoader).signal;
		}
		return this.signalController?.signal ?? new AbortController().signal;
	}

	set onAbort(fn: (() => void) | undefined) {
		if (this.cancellable) {
			(this.loader as CancellableLoader).onAbort = fn;
		}
	}

	handleInput(data: string): void {
		if (this.cancellable) {
			(this.loader as CancellableLoader).handleInput(data);
		}
	}

	dispose(): void {
		if ("dispose" in this.loader && typeof this.loader.dispose === "function") {
			this.loader.dispose();
		}
	}
}
