/**
 * @file 终端接口和实现
 *
 * 本文件定义了 TUI 框架所需的终端抽象接口（Terminal），
 * 以及基于 process.stdin/stdout 的真实终端实现（ProcessTerminal）。
 *
 * ProcessTerminal 负责：
 * - 启用原始模式（raw mode）以获取逐键输入
 * - 查询和启用 Kitty 键盘协议（支持修饰键和按键事件类型）
 * - 启用括号粘贴模式（bracketed paste mode）
 * - Windows 平台的 VT 输入支持
 * - 通过 StdinBuffer 将批量输入拆分为独立序列
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import { setKittyProtocolActive } from "./keys.js";
import { StdinBuffer } from "./stdin-buffer.js";

const cjsRequire = createRequire(import.meta.url);

/**
 * TUI 框架的最小终端接口
 *
 * 定义了 TUI 需要的所有终端操作，
 * 可以用不同的实现替换（如测试用的模拟终端）。
 */
export interface Terminal {
	/** 使用输入和调整大小的处理器启动终端 */
	start(onInput: (data: string) => void, onResize: () => void): void;

	/** 停止终端并恢复状态 */
	stop(): void;

	/**
	 * 在退出前排空标准输入，防止 Kitty 按键释放事件
	 * 在慢速 SSH 连接上泄漏到父 Shell。
	 * @param maxMs - 最大排空时间（默认：1000ms）
	 * @param idleMs - 如果在此时间内没有输入则提前退出（默认：50ms）
	 */
	drainInput(maxMs?: number, idleMs?: number): Promise<void>;

	/** 向终端写入输出 */
	write(data: string): void;

	/** 获取终端列数 */
	get columns(): number;
	/** 获取终端行数 */
	get rows(): number;

	/** Kitty 键盘协议是否处于活跃状态 */
	get kittyProtocolActive(): boolean;

	/** 相对移动光标（正数向下，负数向上） */
	moveBy(lines: number): void;

	/** 隐藏光标 */
	hideCursor(): void;
	/** 显示光标 */
	showCursor(): void;

	/** 清除当前行 */
	clearLine(): void;
	/** 从光标位置清除到屏幕末尾 */
	clearFromCursor(): void;
	/** 清除整个屏幕并将光标移到 (0,0) */
	clearScreen(): void;

	/** 设置终端窗口标题 */
	setTitle(title: string): void;
}

/**
 * 基于 process.stdin/stdout 的真实终端实现
 *
 * 启动时会：
 * 1. 启用原始模式以获取逐键输入
 * 2. 启用括号粘贴模式
 * 3. 查询并启用 Kitty 键盘协议
 * 4. 在 Windows 上启用 VT 输入
 */
export class ProcessTerminal implements Terminal {
	/** 启动前是否已处于原始模式 */
	private wasRaw = false;
	/** 键盘输入处理回调 */
	private inputHandler?: (data: string) => void;
	/** 终端大小调整处理回调 */
	private resizeHandler?: () => void;
	/** Kitty 键盘协议是否已激活 */
	private _kittyProtocolActive = false;
	/** 标准输入缓冲区（将批量输入拆分为独立序列） */
	private stdinBuffer?: StdinBuffer;
	/** stdin data 事件处理器引用（用于后续清理） */
	private stdinDataHandler?: (data: string) => void;
	/** 写入日志路径（调试用） */
	private writeLogPath = process.env.PI_TUI_WRITE_LOG || "";

	get kittyProtocolActive(): boolean {
		return this._kittyProtocolActive;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;

		// Save previous state and enable raw mode
		this.wasRaw = process.stdin.isRaw || false;
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(true);
		}
		process.stdin.setEncoding("utf8");
		process.stdin.resume();

		// Enable bracketed paste mode - terminal will wrap pastes in \x1b[200~ ... \x1b[201~
		process.stdout.write("\x1b[?2004h");

		// Set up resize handler immediately
		process.stdout.on("resize", this.resizeHandler);

		// Refresh terminal dimensions - they may be stale after suspend/resume
		// (SIGWINCH is lost while process is stopped). Unix only.
		if (process.platform !== "win32") {
			process.kill(process.pid, "SIGWINCH");
		}

		// On Windows, enable ENABLE_VIRTUAL_TERMINAL_INPUT so the console sends
		// VT escape sequences (e.g. \x1b[Z for Shift+Tab) instead of raw console
		// events that lose modifier information. Must run AFTER setRawMode(true)
		// since that resets console mode flags.
		this.enableWindowsVTInput();

		// Query and enable Kitty keyboard protocol
		// The query handler intercepts input temporarily, then installs the user's handler
		// See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
		this.queryAndEnableKittyProtocol();
	}

	/**
	 * 设置 StdinBuffer 将批量输入拆分为独立序列。
	 * 确保组件接收单个事件，使 matchesKey/isKeyRelease 正确工作。
	 *
	 * 同时监视 Kitty 协议响应并在检测到时启用。
	 * 在 stdinBuffer 解析之后（而非原始 stdin 上）执行此操作，
	 * 以处理响应跨多个事件分割到达的情况。
	 */
	private setupStdinBuffer(): void {
		this.stdinBuffer = new StdinBuffer({ timeout: 10 });

		// Kitty protocol response pattern: \x1b[?<flags>u
		const kittyResponsePattern = /^\x1b\[\?(\d+)u$/;

		// Forward individual sequences to the input handler
		this.stdinBuffer.on("data", (sequence) => {
			// Check for Kitty protocol response (only if not already enabled)
			if (!this._kittyProtocolActive) {
				const match = sequence.match(kittyResponsePattern);
				if (match) {
					this._kittyProtocolActive = true;
					setKittyProtocolActive(true);

					// Enable Kitty keyboard protocol (push flags)
					// Flag 1 = disambiguate escape codes
					// Flag 2 = report event types (press/repeat/release)
					// Flag 4 = report alternate keys (shifted key, base layout key)
					// Base layout key enables shortcuts to work with non-Latin keyboard layouts
					process.stdout.write("\x1b[>7u");
					return; // Don't forward protocol response to TUI
				}
			}

			if (this.inputHandler) {
				this.inputHandler(sequence);
			}
		});

		// Re-wrap paste content with bracketed paste markers for existing editor handling
		this.stdinBuffer.on("paste", (content) => {
			if (this.inputHandler) {
				this.inputHandler(`\x1b[200~${content}\x1b[201~`);
			}
		});

		// Handler that pipes stdin data through the buffer
		this.stdinDataHandler = (data: string) => {
			this.stdinBuffer!.process(data);
		};
	}

	/**
	 * 查询终端是否支持 Kitty 键盘协议并在支持时启用。
	 *
	 * 发送 CSI ? u 查询当前标志。如果终端响应 CSI ? <flags> u，
	 * 则表示支持该协议，我们用 CSI > 1 u 启用它。
	 *
	 * 响应在 setupStdinBuffer 的 data 处理器中检测，
	 * 能正确处理响应跨多个 stdin 事件分割到达的情况。
	 */
	private queryAndEnableKittyProtocol(): void {
		this.setupStdinBuffer();
		process.stdin.on("data", this.stdinDataHandler!);
		process.stdout.write("\x1b[?u");
	}

	/**
	 * 在 Windows 上为 stdin 控制台句柄添加 ENABLE_VIRTUAL_TERMINAL_INPUT (0x0200)，
	 * 使终端发送 VT 序列来表示修饰键（如 Shift+Tab 的 \x1b[Z）。
	 * 若不启用，libuv 的 ReadConsoleInputW 会丢弃修饰键状态，
	 * Shift+Tab 将作为普通 \t 到达。
	 */
	private enableWindowsVTInput(): void {
		if (process.platform !== "win32") return;
		try {
			// Dynamic require to avoid bundling koffi's 74MB of cross-platform
			// native binaries into every compiled binary. Koffi is only needed
			// on Windows for VT input support.
			const koffi = cjsRequire("koffi");
			const k32 = koffi.load("kernel32.dll");
			const GetStdHandle = k32.func("void* __stdcall GetStdHandle(int)");
			const GetConsoleMode = k32.func("bool __stdcall GetConsoleMode(void*, _Out_ uint32_t*)");
			const SetConsoleMode = k32.func("bool __stdcall SetConsoleMode(void*, uint32_t)");

			const STD_INPUT_HANDLE = -10;
			const ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200;
			const handle = GetStdHandle(STD_INPUT_HANDLE);
			const mode = new Uint32Array(1);
			GetConsoleMode(handle, mode);
			SetConsoleMode(handle, mode[0]! | ENABLE_VIRTUAL_TERMINAL_INPUT);
		} catch {
			// koffi not available — Shift+Tab won't be distinguishable from Tab
		}
	}

	async drainInput(maxMs = 1000, idleMs = 50): Promise<void> {
		if (this._kittyProtocolActive) {
			// Disable Kitty keyboard protocol first so any late key releases
			// do not generate new Kitty escape sequences.
			process.stdout.write("\x1b[<u");
			this._kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}

		const previousHandler = this.inputHandler;
		this.inputHandler = undefined;

		let lastDataTime = Date.now();
		const onData = () => {
			lastDataTime = Date.now();
		};

		process.stdin.on("data", onData);
		const endTime = Date.now() + maxMs;

		try {
			while (true) {
				const now = Date.now();
				const timeLeft = endTime - now;
				if (timeLeft <= 0) break;
				if (now - lastDataTime >= idleMs) break;
				await new Promise((resolve) => setTimeout(resolve, Math.min(idleMs, timeLeft)));
			}
		} finally {
			process.stdin.removeListener("data", onData);
			this.inputHandler = previousHandler;
		}
	}

	stop(): void {
		// Disable bracketed paste mode
		process.stdout.write("\x1b[?2004l");

		// Disable Kitty keyboard protocol if not already done by drainInput()
		if (this._kittyProtocolActive) {
			process.stdout.write("\x1b[<u");
			this._kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}

		// Clean up StdinBuffer
		if (this.stdinBuffer) {
			this.stdinBuffer.destroy();
			this.stdinBuffer = undefined;
		}

		// Remove event handlers
		if (this.stdinDataHandler) {
			process.stdin.removeListener("data", this.stdinDataHandler);
			this.stdinDataHandler = undefined;
		}
		this.inputHandler = undefined;
		if (this.resizeHandler) {
			process.stdout.removeListener("resize", this.resizeHandler);
			this.resizeHandler = undefined;
		}

		// Pause stdin to prevent any buffered input (e.g., Ctrl+D) from being
		// re-interpreted after raw mode is disabled. This fixes a race condition
		// where Ctrl+D could close the parent shell over SSH.
		process.stdin.pause();

		// Restore raw mode state
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(this.wasRaw);
		}
	}

	write(data: string): void {
		process.stdout.write(data);
		if (this.writeLogPath) {
			try {
				fs.appendFileSync(this.writeLogPath, data, { encoding: "utf8" });
			} catch {
				// Ignore logging errors
			}
		}
	}

	get columns(): number {
		return process.stdout.columns || 80;
	}

	get rows(): number {
		return process.stdout.rows || 24;
	}

	moveBy(lines: number): void {
		if (lines > 0) {
			// Move down
			process.stdout.write(`\x1b[${lines}B`);
		} else if (lines < 0) {
			// Move up
			process.stdout.write(`\x1b[${-lines}A`);
		}
		// lines === 0: no movement
	}

	hideCursor(): void {
		process.stdout.write("\x1b[?25l");
	}

	showCursor(): void {
		process.stdout.write("\x1b[?25h");
	}

	clearLine(): void {
		process.stdout.write("\x1b[K");
	}

	clearFromCursor(): void {
		process.stdout.write("\x1b[J");
	}

	clearScreen(): void {
		process.stdout.write("\x1b[2J\x1b[H"); // Clear screen and move to home (1,1)
	}

	setTitle(title: string): void {
		// OSC 0;title BEL - set terminal window title
		process.stdout.write(`\x1b]0;${title}\x07`);
	}
}
