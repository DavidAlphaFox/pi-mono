/**
 * @file tools/truncate.ts - 共享截断工具模块
 *
 * 本文件为工具输出提供统一的截断处理，基于两个独立的限制条件（先触发者生效）：
 * - 行数限制（默认: 2000 行）
 * - 字节限制（默认: 50KB）
 *
 * 提供两种截断方向：
 * - truncateHead: 头部截断（保留前 N 行/字节），适用于文件读取
 * - truncateTail: 尾部截断（保留后 N 行/字节），适用于 bash 输出
 *
 * 不会返回不完整的行（bash 尾部截断的边界情况除外）。
 */

/** 默认最大行数限制 */
export const DEFAULT_MAX_LINES = 2000;
/** 默认最大字节限制（50KB） */
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB

/**
 * 截断处理结果
 */
export interface TruncationResult {
	/** 截断后的内容 */
	content: string;
	/** 是否发生了截断 */
	truncated: boolean;
	/** 触发截断的限制类型："lines"（行数）、"bytes"（字节数）或 null（未截断） */
	truncatedBy: "lines" | "bytes" | null;
	/** 原始内容的总行数 */
	totalLines: number;
	/** 原始内容的总字节数 */
	totalBytes: number;
	/** 截断后输出的完整行数 */
	outputLines: number;
	/** 截断后输出的字节数 */
	outputBytes: number;
	/** 最后一行是否被部分截断（仅在尾部截断的边界情况下发生） */
	lastLinePartial: boolean;
	/** 第一行是否超过字节限制（仅用于头部截断） */
	firstLineExceedsLimit: boolean;
}

/**
 * 截断选项
 */
export interface TruncationOptions {
	/** 最大行数（默认: 2000） */
	maxLines?: number;
	/** 最大字节数（默认: 50KB） */
	maxBytes?: number;
}

/**
 * 将字节数格式化为人类可读的大小字符串
 * @param bytes - 字节数
 * @returns 格式化后的字符串（如 "512B"、"1.5KB"、"2.3MB"）
 */
export function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes}B`;
	} else if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)}KB`;
	} else {
		return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	}
}

/**
 * 头部截断（保留前 N 行/字节）
 * 适用于文件读取场景，用户希望看到文件开头的内容。
 *
 * 不会返回不完整的行。如果第一行就超过字节限制，
 * 返回空内容并设置 firstLineExceedsLimit=true。
 *
 * @param content - 要截断的内容
 * @param options - 截断选项
 * @returns 截断结果
 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = content.split("\n");
	const totalLines = lines.length;

	// 检查是否无需截断
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
		};
	}

	// 检查第一行是否就超过字节限制
	const firstLineBytes = Buffer.byteLength(lines[0], "utf-8");
	if (firstLineBytes > maxBytes) {
		return {
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			totalLines,
			totalBytes,
			outputLines: 0,
			outputBytes: 0,
			lastLinePartial: false,
			firstLineExceedsLimit: true,
		};
	}

	// 逐行收集，直到触发行数或字节数限制
	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";

	for (let i = 0; i < lines.length && i < maxLines; i++) {
		const line = lines[i];
		const lineBytes = Buffer.byteLength(line, "utf-8") + (i > 0 ? 1 : 0); // +1 算换行符

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}

		outputLinesArr.push(line);
		outputBytesCount += lineBytes;
	}

	// 如果是行数限制触发的退出
	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLinesArr.join("\n");
	const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");

	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: finalOutputBytes,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
	};
}

/**
 * 尾部截断（保留后 N 行/字节）
 * 适用于 bash 输出场景，用户希望看到最新的输出（错误信息、最终结果）。
 *
 * 可能返回部分首行（当原始内容的最后一行超过字节限制时）。
 *
 * @param content - 要截断的内容
 * @param options - 截断选项
 * @returns 截断结果
 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = content.split("\n");
	const totalLines = lines.length;

	// 检查是否无需截断
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
		};
	}

	// 从末尾向前逐行收集
	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	let lastLinePartial = false;

	for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i--) {
		const line = lines[i];
		const lineBytes = Buffer.byteLength(line, "utf-8") + (outputLinesArr.length > 0 ? 1 : 0); // +1 算换行符

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			// 边界情况：如果一行都没有添加，且当前行超过限制，取行末尾部分
			if (outputLinesArr.length === 0) {
				const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);
				outputLinesArr.unshift(truncatedLine);
				outputBytesCount = Buffer.byteLength(truncatedLine, "utf-8");
				lastLinePartial = true;
			}
			break;
		}

		outputLinesArr.unshift(line);
		outputBytesCount += lineBytes;
	}

	// 如果是行数限制触发的退出
	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLinesArr.join("\n");
	const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");

	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: finalOutputBytes,
		lastLinePartial,
		firstLineExceedsLimit: false,
	};
}

/**
 * 从字符串末尾截取指定字节数的内容
 * 正确处理多字节 UTF-8 字符，确保不会截断在字符中间
 *
 * @param str - 原始字符串
 * @param maxBytes - 最大字节数
 * @returns 截取后的字符串
 */
function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
	const buf = Buffer.from(str, "utf-8");
	if (buf.length <= maxBytes) {
		return str;
	}

	// 从末尾往回跳 maxBytes 字节
	let start = buf.length - maxBytes;

	// 找到有效的 UTF-8 字符边界（跳过续字节 0x80-0xBF）
	while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
		start++;
	}

	return buf.slice(start).toString("utf-8");
}
