/**
 * 文件写入工具
 *
 * 本文件实现了将内容写入文件的工具，功能包括：
 * 1. 写入文件内容，文件不存在时自动创建
 * 2. 自动递归创建父目录
 * 3. 支持中止信号（AbortSignal）
 * 4. 可插拔的写入操作（WriteOperations），支持远程文件系统（如 SSH）
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { mkdir as fsMkdir, writeFile as fsWriteFile } from "fs/promises";
import { dirname } from "path";
import { resolveToCwd } from "./path-utils.js";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

/** 写入工具的输入参数类型 */
export type WriteToolInput = Static<typeof writeSchema>;

/**
 * 写入工具的可插拔操作接口。
 * 可通过覆写此接口将文件写入委托给远程系统（如 SSH）。
 */
export interface WriteOperations {
	/** 将内容写入文件 */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** 递归创建目录 */
	mkdir: (dir: string) => Promise<void>;
}

const defaultWriteOperations: WriteOperations = {
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
};

/** 写入工具的配置选项 */
export interface WriteToolOptions {
	/** 自定义文件写入操作，默认使用本地文件系统 */
	operations?: WriteOperations;
}

/**
 * 创建绑定到指定工作目录的文件写入工具实例。
 * 自动创建父目录，支持中止操作。
 */
export function createWriteTool(cwd: string, options?: WriteToolOptions): AgentTool<typeof writeSchema> {
	const ops = options?.operations ?? defaultWriteOperations;

	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		parameters: writeSchema,
		execute: async (
			_toolCallId: string,
			{ path, content }: { path: string; content: string },
			signal?: AbortSignal,
		) => {
			const absolutePath = resolveToCwd(path, cwd);
			const dir = dirname(absolutePath);

			return new Promise<{ content: Array<{ type: "text"; text: string }>; details: undefined }>(
				(resolve, reject) => {
					// Check if already aborted
					if (signal?.aborted) {
						reject(new Error("Operation aborted"));
						return;
					}

					let aborted = false;

					// Set up abort handler
					const onAbort = () => {
						aborted = true;
						reject(new Error("Operation aborted"));
					};

					if (signal) {
						signal.addEventListener("abort", onAbort, { once: true });
					}

					// Perform the write operation
					(async () => {
						try {
							// Create parent directories if needed
							await ops.mkdir(dir);

							// Check if aborted before writing
							if (aborted) {
								return;
							}

							// Write the file
							await ops.writeFile(absolutePath, content);

							// Check if aborted after writing
							if (aborted) {
								return;
							}

							// Clean up abort handler
							if (signal) {
								signal.removeEventListener("abort", onAbort);
							}

							resolve({
								content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` }],
								details: undefined,
							});
						} catch (error: any) {
							// Clean up abort handler
							if (signal) {
								signal.removeEventListener("abort", onAbort);
							}

							if (!aborted) {
								reject(error);
							}
						}
					})();
				},
			);
		},
	};
}

/** 使用 process.cwd() 的默认写入工具实例，保持向后兼容 */
export const writeTool = createWriteTool(process.cwd());
