/**
 * @file tools/bash.ts - Bash 命令执行工具
 *
 * 本文件负责：
 * 1. 定义 bash 工具的参数 schema（label、command、timeout）
 * 2. 通过 Executor 执行 bash 命令
 * 3. 对输出进行尾部截断处理（超过 2000 行或 50KB 时截断）
 * 4. 超长输出保存到临时文件，并在结果中附带文件路径
 * 5. 非零退出码时抛出错误
 */

import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Executor } from "../sandbox.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateTail } from "./truncate.js";

/**
 * 生成唯一的临时文件路径，用于保存完整的 bash 输出
 * @returns 临时文件的绝对路径
 */
function getTempFilePath(): string {
	const id = randomBytes(8).toString("hex");
	return join(tmpdir(), `mom-bash-${id}.log`);
}

/** bash 工具的参数 schema 定义 */
const bashSchema = Type.Object({
	label: Type.String({ description: "Brief description of what this command does (shown to user)" }),
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

/**
 * bash 工具的详细信息（附带在执行结果中）
 */
interface BashToolDetails {
	/** 截断信息 */
	truncation?: TruncationResult;
	/** 完整输出保存的临时文件路径 */
	fullOutputPath?: string;
}

/**
 * 创建 bash 工具
 * 执行 bash 命令并返回输出，支持超时设置。
 * 输出超过限制时会进行尾部截断，完整输出保存到临时文件。
 *
 * @param executor - 命令执行器（Host 或 Docker）
 * @returns AgentTool 实例
 */
export function createBashTool(executor: Executor): AgentTool<typeof bashSchema> {
	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
		parameters: bashSchema,
		execute: async (
			_toolCallId: string,
			{ command, timeout }: { label: string; command: string; timeout?: number },
			signal?: AbortSignal,
		) => {
			let tempFilePath: string | undefined;
			let tempFileStream: ReturnType<typeof createWriteStream> | undefined;

			// 执行命令
			const result = await executor.exec(command, { timeout, signal });

			// 合并 stdout 和 stderr
			let output = "";
			if (result.stdout) output += result.stdout;
			if (result.stderr) {
				if (output) output += "\n";
				output += result.stderr;
			}

			const totalBytes = Buffer.byteLength(output, "utf-8");

			// 输出超过字节限制时写入临时文件
			if (totalBytes > DEFAULT_MAX_BYTES) {
				tempFilePath = getTempFilePath();
				tempFileStream = createWriteStream(tempFilePath);
				tempFileStream.write(output);
				tempFileStream.end();
			}

			// 应用尾部截断（保留最后 N 行/字节）
			const truncation = truncateTail(output);
			let outputText = truncation.content || "(no output)";

			// 构建截断详细信息
			let details: BashToolDetails | undefined;

			if (truncation.truncated) {
				details = {
					truncation,
					fullOutputPath: tempFilePath,
				};

				// 构建可操作的截断提示
				const startLine = truncation.totalLines - truncation.outputLines + 1;
				const endLine = truncation.totalLines;

				if (truncation.lastLinePartial) {
					// 边界情况：最后一行本身超过 50KB
					const lastLineSize = formatSize(Buffer.byteLength(output.split("\n").pop() || "", "utf-8"));
					outputText += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${tempFilePath}]`;
				} else if (truncation.truncatedBy === "lines") {
					// 按行数截断
					outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${tempFilePath}]`;
				} else {
					// 按字节数截断
					outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${tempFilePath}]`;
				}
			}

			// 非零退出码时抛出错误
			if (result.code !== 0) {
				throw new Error(`${outputText}\n\nCommand exited with code ${result.code}`.trim());
			}

			return { content: [{ type: "text", text: outputText }], details };
		},
	};
}
