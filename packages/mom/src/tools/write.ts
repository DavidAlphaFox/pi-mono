/**
 * @file tools/write.ts - 文件写入工具
 *
 * 本文件负责：
 * 1. 定义 write 工具的参数 schema（label、path、content）
 * 2. 通过 Executor 写入文件内容
 * 3. 自动创建父目录
 * 4. 使用 printf 和 shell 转义处理特殊字符
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Executor } from "../sandbox.js";

/** write 工具的参数 schema 定义 */
const writeSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're writing (shown to user)" }),
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

/**
 * 创建 write 工具
 * 将内容写入文件，文件不存在则创建，已存在则覆盖。
 * 自动创建必要的父目录。
 *
 * @param executor - 命令执行器（Host 或 Docker）
 * @returns AgentTool 实例
 */
export function createWriteTool(executor: Executor): AgentTool<typeof writeSchema> {
	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		parameters: writeSchema,
		execute: async (
			_toolCallId: string,
			{ path, content }: { label: string; path: string; content: string },
			signal?: AbortSignal,
		) => {
			// 提取父目录路径
			const dir = path.includes("/") ? path.substring(0, path.lastIndexOf("/")) : ".";

			// 使用 printf 写入文件（避免 heredoc 中特殊字符的问题）
			const cmd = `mkdir -p ${shellEscape(dir)} && printf '%s' ${shellEscape(content)} > ${shellEscape(path)}`;

			const result = await executor.exec(cmd, { signal });
			if (result.code !== 0) {
				throw new Error(result.stderr || `Failed to write file: ${path}`);
			}

			return {
				content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` }],
				details: undefined,
			};
		},
	};
}

/**
 * Shell 参数转义
 * @param s - 要转义的字符串
 * @returns 转义后的字符串
 */
function shellEscape(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}
