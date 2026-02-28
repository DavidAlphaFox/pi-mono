/**
 * @file 标准输入缓冲区
 *
 * StdinBuffer 缓冲输入数据并发出完整的序列。
 *
 * 这是必要的，因为 stdin data 事件可能以部分块的方式到达，
 * 特别是鼠标事件等转义序列。没有缓冲的话，
 * 部分序列可能被误解为普通按键。
 *
 * 例如，鼠标 SGR 序列 `\x1b[<35;20;5m` 可能分三次到达：
 * - 事件 1: `\x1b`
 * - 事件 2: `[<35`
 * - 事件 3: `;20;5m`
 *
 * 缓冲区会累积这些数据直到检测到完整序列。
 * 通过调用 `process()` 方法来送入输入数据。
 *
 * 基于 OpenTUI (https://github.com/anomalyco/opentui) 的代码
 * MIT 许可证 - Copyright (c) 2025 opentui
 */

import { EventEmitter } from "events";

/** ESC 转义字符 */
const ESC = "\x1b";
/** 括号粘贴模式起始标记 */
const BRACKETED_PASTE_START = "\x1b[200~";
/** 括号粘贴模式结束标记 */
const BRACKETED_PASTE_END = "\x1b[201~";

/** 检查字符串是否为完整的转义序列，还是需要更多数据 */
function isCompleteSequence(data: string): "complete" | "incomplete" | "not-escape" {
	if (!data.startsWith(ESC)) {
		return "not-escape";
	}

	if (data.length === 1) {
		return "incomplete";
	}

	const afterEsc = data.slice(1);

	// CSI sequences: ESC [
	if (afterEsc.startsWith("[")) {
		// Check for old-style mouse sequence: ESC[M + 3 bytes
		if (afterEsc.startsWith("[M")) {
			// Old-style mouse needs ESC[M + 3 bytes = 6 total
			return data.length >= 6 ? "complete" : "incomplete";
		}
		return isCompleteCsiSequence(data);
	}

	// OSC sequences: ESC ]
	if (afterEsc.startsWith("]")) {
		return isCompleteOscSequence(data);
	}

	// DCS sequences: ESC P ... ESC \ (includes XTVersion responses)
	if (afterEsc.startsWith("P")) {
		return isCompleteDcsSequence(data);
	}

	// APC sequences: ESC _ ... ESC \ (includes Kitty graphics responses)
	if (afterEsc.startsWith("_")) {
		return isCompleteApcSequence(data);
	}

	// SS3 sequences: ESC O
	if (afterEsc.startsWith("O")) {
		// ESC O followed by a single character
		return afterEsc.length >= 2 ? "complete" : "incomplete";
	}

	// Meta key sequences: ESC followed by a single character
	if (afterEsc.length === 1) {
		return "complete";
	}

	// Unknown escape sequence - treat as complete
	return "complete";
}

/**
 * 检查 CSI 序列是否完整。
 * CSI 序列格式：ESC [ ... 后跟终止字节 (0x40-0x7E)
 */
function isCompleteCsiSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}[`)) {
		return "complete";
	}

	// Need at least ESC [ and one more character
	if (data.length < 3) {
		return "incomplete";
	}

	const payload = data.slice(2);

	// CSI sequences end with a byte in the range 0x40-0x7E (@-~)
	// This includes all letters and several special characters
	const lastChar = payload[payload.length - 1];
	const lastCharCode = lastChar.charCodeAt(0);

	if (lastCharCode >= 0x40 && lastCharCode <= 0x7e) {
		// Special handling for SGR mouse sequences
		// Format: ESC[<B;X;Ym or ESC[<B;X;YM
		if (payload.startsWith("<")) {
			// Must have format: <digits;digits;digits[Mm]
			const mouseMatch = /^<\d+;\d+;\d+[Mm]$/.test(payload);
			if (mouseMatch) {
				return "complete";
			}
			// If it ends with M or m but doesn't match the pattern, still incomplete
			if (lastChar === "M" || lastChar === "m") {
				// Check if we have the right structure
				const parts = payload.slice(1, -1).split(";");
				if (parts.length === 3 && parts.every((p) => /^\d+$/.test(p))) {
					return "complete";
				}
			}

			return "incomplete";
		}

		return "complete";
	}

	return "incomplete";
}

/**
 * 检查 OSC 序列是否完整。
 * OSC 序列格式：ESC ] ... ST（ST 为 ESC \ 或 BEL）
 */
function isCompleteOscSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}]`)) {
		return "complete";
	}

	// OSC sequences end with ST (ESC \) or BEL (\x07)
	if (data.endsWith(`${ESC}\\`) || data.endsWith("\x07")) {
		return "complete";
	}

	return "incomplete";
}

/**
 * 检查 DCS（设备控制字符串）序列是否完整。
 * DCS 序列格式：ESC P ... ST（ST 为 ESC \）
 * 用于 XTVersion 响应，如 ESC P >| ... ESC \
 */
function isCompleteDcsSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}P`)) {
		return "complete";
	}

	// DCS sequences end with ST (ESC \)
	if (data.endsWith(`${ESC}\\`)) {
		return "complete";
	}

	return "incomplete";
}

/**
 * 检查 APC（应用程序命令）序列是否完整。
 * APC 序列格式：ESC _ ... ST（ST 为 ESC \）
 * 用于 Kitty 图形响应，如 ESC _ G ... ESC \
 */
function isCompleteApcSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}_`)) {
		return "complete";
	}

	// APC sequences end with ST (ESC \)
	if (data.endsWith(`${ESC}\\`)) {
		return "complete";
	}

	return "incomplete";
}

/** 将累积的缓冲区拆分为完整的序列 */
function extractCompleteSequences(buffer: string): { sequences: string[]; remainder: string } {
	const sequences: string[] = [];
	let pos = 0;

	while (pos < buffer.length) {
		const remaining = buffer.slice(pos);

		// Try to extract a sequence starting at this position
		if (remaining.startsWith(ESC)) {
			// Find the end of this escape sequence
			let seqEnd = 1;
			while (seqEnd <= remaining.length) {
				const candidate = remaining.slice(0, seqEnd);
				const status = isCompleteSequence(candidate);

				if (status === "complete") {
					sequences.push(candidate);
					pos += seqEnd;
					break;
				} else if (status === "incomplete") {
					seqEnd++;
				} else {
					// Should not happen when starting with ESC
					sequences.push(candidate);
					pos += seqEnd;
					break;
				}
			}

			if (seqEnd > remaining.length) {
				return { sequences, remainder: remaining };
			}
		} else {
			// Not an escape sequence - take a single character
			sequences.push(remaining[0]!);
			pos++;
		}
	}

	return { sequences, remainder: "" };
}

/** StdinBuffer 配置选项 */
export type StdinBufferOptions = {
	/**
	 * 等待序列完成的最大时间（默认 10ms）。
	 * 超时后即使序列不完整也会刷新缓冲区。
	 */
	timeout?: number;
};

/** StdinBuffer 事件映射类型 */
export type StdinBufferEventMap = {
	/** 完整的输入序列 */
	data: [string];
	/** 括号粘贴模式中的粘贴内容 */
	paste: [string];
};

/**
 * 标准输入缓冲区。
 * 缓冲 stdin 输入并通过 'data' 事件发出完整的序列。
 * 处理跨多个数据块到达的部分转义序列。
 */
export class StdinBuffer extends EventEmitter<StdinBufferEventMap> {
	/** 输入缓冲区 */
	private buffer: string = "";
	/** 超时定时器句柄 */
	private timeout: ReturnType<typeof setTimeout> | null = null;
	/** 超时时间（毫秒） */
	private readonly timeoutMs: number;
	/** 是否处于括号粘贴模式 */
	private pasteMode: boolean = false;
	/** 粘贴内容缓冲区 */
	private pasteBuffer: string = "";

	constructor(options: StdinBufferOptions = {}) {
		super();
		this.timeoutMs = options.timeout ?? 10;
	}

	/** 处理输入数据，提取完整序列并发出事件 */
	public process(data: string | Buffer): void {
		// Clear any pending timeout
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}

		// Handle high-byte conversion (for compatibility with parseKeypress)
		// If buffer has single byte > 127, convert to ESC + (byte - 128)
		let str: string;
		if (Buffer.isBuffer(data)) {
			if (data.length === 1 && data[0]! > 127) {
				const byte = data[0]! - 128;
				str = `\x1b${String.fromCharCode(byte)}`;
			} else {
				str = data.toString();
			}
		} else {
			str = data;
		}

		if (str.length === 0 && this.buffer.length === 0) {
			this.emit("data", "");
			return;
		}

		this.buffer += str;

		if (this.pasteMode) {
			this.pasteBuffer += this.buffer;
			this.buffer = "";

			const endIndex = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
			if (endIndex !== -1) {
				const pastedContent = this.pasteBuffer.slice(0, endIndex);
				const remaining = this.pasteBuffer.slice(endIndex + BRACKETED_PASTE_END.length);

				this.pasteMode = false;
				this.pasteBuffer = "";

				this.emit("paste", pastedContent);

				if (remaining.length > 0) {
					this.process(remaining);
				}
			}
			return;
		}

		const startIndex = this.buffer.indexOf(BRACKETED_PASTE_START);
		if (startIndex !== -1) {
			if (startIndex > 0) {
				const beforePaste = this.buffer.slice(0, startIndex);
				const result = extractCompleteSequences(beforePaste);
				for (const sequence of result.sequences) {
					this.emit("data", sequence);
				}
			}

			this.buffer = this.buffer.slice(startIndex + BRACKETED_PASTE_START.length);
			this.pasteMode = true;
			this.pasteBuffer = this.buffer;
			this.buffer = "";

			const endIndex = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
			if (endIndex !== -1) {
				const pastedContent = this.pasteBuffer.slice(0, endIndex);
				const remaining = this.pasteBuffer.slice(endIndex + BRACKETED_PASTE_END.length);

				this.pasteMode = false;
				this.pasteBuffer = "";

				this.emit("paste", pastedContent);

				if (remaining.length > 0) {
					this.process(remaining);
				}
			}
			return;
		}

		const result = extractCompleteSequences(this.buffer);
		this.buffer = result.remainder;

		for (const sequence of result.sequences) {
			this.emit("data", sequence);
		}

		if (this.buffer.length > 0) {
			this.timeout = setTimeout(() => {
				const flushed = this.flush();

				for (const sequence of flushed) {
					this.emit("data", sequence);
				}
			}, this.timeoutMs);
		}
	}

	/** 刷新缓冲区，返回所有待处理的序列 */
	flush(): string[] {
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}

		if (this.buffer.length === 0) {
			return [];
		}

		const sequences = [this.buffer];
		this.buffer = "";
		return sequences;
	}

	/** 清除所有缓冲区状态和定时器 */
	clear(): void {
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}
		this.buffer = "";
		this.pasteMode = false;
		this.pasteBuffer = "";
	}

	/** 获取当前缓冲区内容 */
	getBuffer(): string {
		return this.buffer;
	}

	/** 销毁缓冲区，清除所有状态 */
	destroy(): void {
		this.clear();
	}
}
