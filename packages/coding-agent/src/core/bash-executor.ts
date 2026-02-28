/**
 * Bash 命令执行模块 - 支持流式输出和取消
 *
 * 职责：
 * - 统一的 bash 执行实现，供 AgentSession.executeBash() 和各运行模式使用
 * - 流式输出已净化的文本（去除 ANSI 转义、二进制垃圾、规范化换行）
 * - 大输出自动写入临时文件
 * - 通过 AbortSignal 支持取消
 * - 超出阈值时自动截断输出
 */

import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChildProcess, spawn } from "child_process";
import stripAnsi from "strip-ansi";
import { getShellConfig, getShellEnv, killProcessTree, sanitizeBinaryOutput } from "../utils/shell.js";
import type { BashOperations } from "./tools/bash.js";
import { DEFAULT_MAX_BYTES, truncateTail } from "./tools/truncate.js";

// ============================================================================
// Types
// ============================================================================

/** Bash 执行器选项 */
export interface BashExecutorOptions {
	/** 流式输出块的回调（已净化） */
	onChunk?: (chunk: string) => void;
	/** 用于取消的 AbortSignal */
	signal?: AbortSignal;
}

/** Bash 执行结果 */
export interface BashResult {
	/** 合并的 stdout + stderr 输出（已净化，可能被截断） */
	output: string;
	/** 进程退出码（被终止/取消时为 undefined） */
	exitCode: number | undefined;
	/** 是否通过信号取消 */
	cancelled: boolean;
	/** 输出是否被截断 */
	truncated: boolean;
	/** 包含完整输出的临时文件路径（输出超过截断阈值时） */
	fullOutputPath?: string;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * 执行 bash 命令，支持可选的流式输出和取消
 *
 * 功能：
 * - 通过 onChunk 回调流式输出已净化文本
 * - 大输出写入临时文件
 * - 通过 AbortSignal 支持取消
 * - 净化输出（去除 ANSI、移除二进制垃圾、规范化换行）
 * - 超出默认最大字节数时截断输出
 */
export function executeBash(command: string, options?: BashExecutorOptions): Promise<BashResult> {
	return new Promise((resolve, reject) => {
		const { shell, args } = getShellConfig();
		const child: ChildProcess = spawn(shell, [...args, command], {
			detached: true,
			env: getShellEnv(),
			stdio: ["ignore", "pipe", "pipe"],
		});

		// Track sanitized output for truncation
		const outputChunks: string[] = [];
		let outputBytes = 0;
		const maxOutputBytes = DEFAULT_MAX_BYTES * 2;

		// Temp file for large output
		let tempFilePath: string | undefined;
		let tempFileStream: WriteStream | undefined;
		let totalBytes = 0;

		// Handle abort signal
		const abortHandler = () => {
			if (child.pid) {
				killProcessTree(child.pid);
			}
		};

		if (options?.signal) {
			if (options.signal.aborted) {
				// Already aborted, don't even start
				child.kill();
				resolve({
					output: "",
					exitCode: undefined,
					cancelled: true,
					truncated: false,
				});
				return;
			}
			options.signal.addEventListener("abort", abortHandler, { once: true });
		}

		const decoder = new TextDecoder();

		const handleData = (data: Buffer) => {
			totalBytes += data.length;

			// Sanitize once at the source: strip ANSI, replace binary garbage, normalize newlines
			const text = sanitizeBinaryOutput(stripAnsi(decoder.decode(data, { stream: true }))).replace(/\r/g, "");

			// Start writing to temp file if exceeds threshold
			if (totalBytes > DEFAULT_MAX_BYTES && !tempFilePath) {
				const id = randomBytes(8).toString("hex");
				tempFilePath = join(tmpdir(), `pi-bash-${id}.log`);
				tempFileStream = createWriteStream(tempFilePath);
				// Write already-buffered chunks to temp file
				for (const chunk of outputChunks) {
					tempFileStream.write(chunk);
				}
			}

			if (tempFileStream) {
				tempFileStream.write(text);
			}

			// Keep rolling buffer of sanitized text
			outputChunks.push(text);
			outputBytes += text.length;
			while (outputBytes > maxOutputBytes && outputChunks.length > 1) {
				const removed = outputChunks.shift()!;
				outputBytes -= removed.length;
			}

			// Stream to callback if provided
			if (options?.onChunk) {
				options.onChunk(text);
			}
		};

		child.stdout?.on("data", handleData);
		child.stderr?.on("data", handleData);

		child.on("close", (code) => {
			// Clean up abort listener
			if (options?.signal) {
				options.signal.removeEventListener("abort", abortHandler);
			}

			if (tempFileStream) {
				tempFileStream.end();
			}

			// Combine buffered chunks for truncation (already sanitized)
			const fullOutput = outputChunks.join("");
			const truncationResult = truncateTail(fullOutput);

			// code === null means killed (cancelled)
			const cancelled = code === null;

			resolve({
				output: truncationResult.truncated ? truncationResult.content : fullOutput,
				exitCode: cancelled ? undefined : code,
				cancelled,
				truncated: truncationResult.truncated,
				fullOutputPath: tempFilePath,
			});
		});

		child.on("error", (err) => {
			// Clean up abort listener
			if (options?.signal) {
				options.signal.removeEventListener("abort", abortHandler);
			}

			if (tempFileStream) {
				tempFileStream.end();
			}

			reject(err);
		});
	});
}

/**
 * 使用自定义 BashOperations 执行 bash 命令
 * 用于远程执行（SSH、容器等）
 */
export async function executeBashWithOperations(
	command: string,
	cwd: string,
	operations: BashOperations,
	options?: BashExecutorOptions,
): Promise<BashResult> {
	const outputChunks: string[] = [];
	let outputBytes = 0;
	const maxOutputBytes = DEFAULT_MAX_BYTES * 2;

	let tempFilePath: string | undefined;
	let tempFileStream: WriteStream | undefined;
	let totalBytes = 0;

	const decoder = new TextDecoder();

	const onData = (data: Buffer) => {
		totalBytes += data.length;

		// Sanitize: strip ANSI, replace binary garbage, normalize newlines
		const text = sanitizeBinaryOutput(stripAnsi(decoder.decode(data, { stream: true }))).replace(/\r/g, "");

		// Start writing to temp file if exceeds threshold
		if (totalBytes > DEFAULT_MAX_BYTES && !tempFilePath) {
			const id = randomBytes(8).toString("hex");
			tempFilePath = join(tmpdir(), `pi-bash-${id}.log`);
			tempFileStream = createWriteStream(tempFilePath);
			for (const chunk of outputChunks) {
				tempFileStream.write(chunk);
			}
		}

		if (tempFileStream) {
			tempFileStream.write(text);
		}

		// Keep rolling buffer
		outputChunks.push(text);
		outputBytes += text.length;
		while (outputBytes > maxOutputBytes && outputChunks.length > 1) {
			const removed = outputChunks.shift()!;
			outputBytes -= removed.length;
		}

		// Stream to callback
		if (options?.onChunk) {
			options.onChunk(text);
		}
	};

	try {
		const result = await operations.exec(command, cwd, {
			onData,
			signal: options?.signal,
		});

		if (tempFileStream) {
			tempFileStream.end();
		}

		const fullOutput = outputChunks.join("");
		const truncationResult = truncateTail(fullOutput);
		const cancelled = options?.signal?.aborted ?? false;

		return {
			output: truncationResult.truncated ? truncationResult.content : fullOutput,
			exitCode: cancelled ? undefined : (result.exitCode ?? undefined),
			cancelled,
			truncated: truncationResult.truncated,
			fullOutputPath: tempFilePath,
		};
	} catch (err) {
		if (tempFileStream) {
			tempFileStream.end();
		}

		// Check if it was an abort
		if (options?.signal?.aborted) {
			const fullOutput = outputChunks.join("");
			const truncationResult = truncateTail(fullOutput);
			return {
				output: truncationResult.truncated ? truncationResult.content : fullOutput,
				exitCode: undefined,
				cancelled: true,
				truncated: truncationResult.truncated,
				fullOutputPath: tempFilePath,
			};
		}

		throw err;
	}
}
