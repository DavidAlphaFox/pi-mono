/**
 * Bash 命令执行工具
 *
 * 本文件实现了在当前工作目录下执行 Bash 命令的工具，功能包括：
 * 1. 通过子进程执行 shell 命令，支持 stdout/stderr 流式输出
 * 2. 支持超时控制和中止信号（AbortSignal）
 * 3. 输出截断：保留最后 N 行/N 字节，超出部分写入临时文件
 * 4. 可插拔的执行操作（BashOperations），支持远程执行（如 SSH）
 * 5. 支持命令前缀和进程上下文钩子（spawnHook）
 */

import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { spawn } from "child_process";
import { getShellConfig, getShellEnv, killProcessTree } from "../../utils/shell.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateTail } from "./truncate.js";

/**
 * 生成唯一的临时文件路径，用于保存 Bash 命令的完整输出。
 */
function getTempFilePath(): string {
	const id = randomBytes(8).toString("hex");
	return join(tmpdir(), `pi-bash-${id}.log`);
}

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

/** Bash 工具的输入参数类型 */
export type BashToolInput = Static<typeof bashSchema>;

/** Bash 工具的详细信息，包含截断信息和完整输出路径 */
export interface BashToolDetails {
	/** 输出截断结果（如果发生了截断） */
	truncation?: TruncationResult;
	/** 完整输出保存的临时文件路径 */
	fullOutputPath?: string;
}

/**
 * Bash 工具的可插拔操作接口。
 * 可通过覆写此接口将命令执行委托给远程系统（如 SSH）。
 */
export interface BashOperations {
	/**
	 * 执行命令并流式输出结果。
	 * @param command - 要执行的命令
	 * @param cwd - 工作目录
	 * @param options - 执行选项
	 * @returns 返回退出码的 Promise（被杀死时为 null）
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
}

/**
 * 默认的 Bash 操作实现，使用本地 shell 执行命令。
 */
const defaultBashOperations: BashOperations = {
	exec: (command, cwd, { onData, signal, timeout, env }) => {
		return new Promise((resolve, reject) => {
			const { shell, args } = getShellConfig();

			if (!existsSync(cwd)) {
				reject(new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`));
				return;
			}

			const child = spawn(shell, [...args, command], {
				cwd,
				detached: true,
				env: env ?? getShellEnv(),
				stdio: ["ignore", "pipe", "pipe"],
			});

			let timedOut = false;

			// Set timeout if provided
			let timeoutHandle: NodeJS.Timeout | undefined;
			if (timeout !== undefined && timeout > 0) {
				timeoutHandle = setTimeout(() => {
					timedOut = true;
					if (child.pid) {
						killProcessTree(child.pid);
					}
				}, timeout * 1000);
			}

			// Stream stdout and stderr
			if (child.stdout) {
				child.stdout.on("data", onData);
			}
			if (child.stderr) {
				child.stderr.on("data", onData);
			}

			// Handle shell spawn errors
			child.on("error", (err) => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
				reject(err);
			});

			// Handle abort signal - kill entire process tree
			const onAbort = () => {
				if (child.pid) {
					killProcessTree(child.pid);
				}
			};

			if (signal) {
				if (signal.aborted) {
					onAbort();
				} else {
					signal.addEventListener("abort", onAbort, { once: true });
				}
			}

			// Handle process exit
			child.on("close", (code) => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);

				if (signal?.aborted) {
					reject(new Error("aborted"));
					return;
				}

				if (timedOut) {
					reject(new Error(`timeout:${timeout}`));
					return;
				}

				resolve({ exitCode: code });
			});
		});
	},
};

/** Bash 进程的上下文信息，包含命令、工作目录和环境变量 */
export interface BashSpawnContext {
	/** 要执行的命令 */
	command: string;
	/** 工作目录 */
	cwd: string;
	/** 环境变量 */
	env: NodeJS.ProcessEnv;
}

/** 进程上下文钩子，用于在执行前修改命令、工作目录或环境变量 */
export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

/**
 * 解析进程上下文：构建基础上下文，然后应用可选的钩子进行变换。
 */
function resolveSpawnContext(command: string, cwd: string, spawnHook?: BashSpawnHook): BashSpawnContext {
	const baseContext: BashSpawnContext = {
		command,
		cwd,
		env: { ...getShellEnv() },
	};

	return spawnHook ? spawnHook(baseContext) : baseContext;
}

/** Bash 工具的配置选项 */
export interface BashToolOptions {
	/** 自定义命令执行操作，默认使用本地 shell */
	operations?: BashOperations;
	/** 命令前缀，会添加到每条命令之前（例如 "shopt -s expand_aliases" 以支持别名） */
	commandPrefix?: string;
	/** 执行前的钩子，用于调整命令、工作目录或环境变量 */
	spawnHook?: BashSpawnHook;
}

/**
 * 创建绑定到指定工作目录的 Bash 工具实例。
 * 支持流式输出、超时控制、输出截断以及大输出自动写入临时文件。
 */
export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	const ops = options?.operations ?? defaultBashOperations;
	const commandPrefix = options?.commandPrefix;
	const spawnHook = options?.spawnHook;

	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
		parameters: bashSchema,
		execute: async (
			_toolCallId: string,
			{ command, timeout }: { command: string; timeout?: number },
			signal?: AbortSignal,
			onUpdate?,
		) => {
			// Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(resolvedCommand, cwd, spawnHook);

			return new Promise((resolve, reject) => {
				// We'll stream to a temp file if output gets large
				let tempFilePath: string | undefined;
				let tempFileStream: ReturnType<typeof createWriteStream> | undefined;
				let totalBytes = 0;

				// Keep a rolling buffer of the last chunk for tail truncation
				const chunks: Buffer[] = [];
				let chunksBytes = 0;
				// Keep more than we need so we have enough for truncation
				const maxChunksBytes = DEFAULT_MAX_BYTES * 2;

				const handleData = (data: Buffer) => {
					totalBytes += data.length;

					// Start writing to temp file once we exceed the threshold
					if (totalBytes > DEFAULT_MAX_BYTES && !tempFilePath) {
						tempFilePath = getTempFilePath();
						tempFileStream = createWriteStream(tempFilePath);
						// Write all buffered chunks to the file
						for (const chunk of chunks) {
							tempFileStream.write(chunk);
						}
					}

					// Write to temp file if we have one
					if (tempFileStream) {
						tempFileStream.write(data);
					}

					// Keep rolling buffer of recent data
					chunks.push(data);
					chunksBytes += data.length;

					// Trim old chunks if buffer is too large
					while (chunksBytes > maxChunksBytes && chunks.length > 1) {
						const removed = chunks.shift()!;
						chunksBytes -= removed.length;
					}

					// Stream partial output to callback (truncated rolling buffer)
					if (onUpdate) {
						const fullBuffer = Buffer.concat(chunks);
						const fullText = fullBuffer.toString("utf-8");
						const truncation = truncateTail(fullText);
						onUpdate({
							content: [{ type: "text", text: truncation.content || "" }],
							details: {
								truncation: truncation.truncated ? truncation : undefined,
								fullOutputPath: tempFilePath,
							},
						});
					}
				};

				ops.exec(spawnContext.command, spawnContext.cwd, {
					onData: handleData,
					signal,
					timeout,
					env: spawnContext.env,
				})
					.then(({ exitCode }) => {
						// Close temp file stream
						if (tempFileStream) {
							tempFileStream.end();
						}

						// Combine all buffered chunks
						const fullBuffer = Buffer.concat(chunks);
						const fullOutput = fullBuffer.toString("utf-8");

						// Apply tail truncation
						const truncation = truncateTail(fullOutput);
						let outputText = truncation.content || "(no output)";

						// Build details with truncation info
						let details: BashToolDetails | undefined;

						if (truncation.truncated) {
							details = {
								truncation,
								fullOutputPath: tempFilePath,
							};

							// Build actionable notice
							const startLine = truncation.totalLines - truncation.outputLines + 1;
							const endLine = truncation.totalLines;

							if (truncation.lastLinePartial) {
								// Edge case: last line alone > 30KB
								const lastLineSize = formatSize(Buffer.byteLength(fullOutput.split("\n").pop() || "", "utf-8"));
								outputText += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${tempFilePath}]`;
							} else if (truncation.truncatedBy === "lines") {
								outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${tempFilePath}]`;
							} else {
								outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${tempFilePath}]`;
							}
						}

						if (exitCode !== 0 && exitCode !== null) {
							outputText += `\n\nCommand exited with code ${exitCode}`;
							reject(new Error(outputText));
						} else {
							resolve({ content: [{ type: "text", text: outputText }], details });
						}
					})
					.catch((err: Error) => {
						// Close temp file stream
						if (tempFileStream) {
							tempFileStream.end();
						}

						// Combine all buffered chunks for error output
						const fullBuffer = Buffer.concat(chunks);
						let output = fullBuffer.toString("utf-8");

						if (err.message === "aborted") {
							if (output) output += "\n\n";
							output += "Command aborted";
							reject(new Error(output));
						} else if (err.message.startsWith("timeout:")) {
							const timeoutSecs = err.message.split(":")[1];
							if (output) output += "\n\n";
							output += `Command timed out after ${timeoutSecs} seconds`;
							reject(new Error(output));
						} else {
							reject(err);
						}
					});
			});
		},
	};
}

/** 使用 process.cwd() 的默认 Bash 工具实例，保持向后兼容 */
export const bashTool = createBashTool(process.cwd());
