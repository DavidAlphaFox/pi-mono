/**
 * @file tools/attach.ts - 文件附件上传工具
 *
 * 本文件负责：
 * 1. 定义 attach 工具的参数 schema（label、path、title）
 * 2. 通过可替换的上传函数将文件发送到 Slack 频道
 * 3. 提供 setUploadFunction 用于运行时注入上传回调
 *
 * 上传函数在每次 Agent 运行前由 agent.ts 设置，
 * 用于将容器内路径转换为宿主机路径后执行实际上传。
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { basename, resolve as resolvePath } from "path";

/** 上传函数引用，由 agent.ts 在运行前通过 setUploadFunction 设置 */
let uploadFn: ((filePath: string, title?: string) => Promise<void>) | null = null;

/**
 * 设置文件上传函数
 * 在每次 Agent 运行前调用，注入当前运行上下文的上传回调
 * @param fn - 上传函数，接收文件路径和可选标题
 */
export function setUploadFunction(fn: (filePath: string, title?: string) => Promise<void>): void {
	uploadFn = fn;
}

/** attach 工具的参数 schema 定义 */
const attachSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're sharing (shown to user)" }),
	path: Type.String({ description: "Path to the file to attach" }),
	title: Type.Optional(Type.String({ description: "Title for the file (defaults to filename)" })),
});

/**
 * attach 工具实例
 * 将文件作为附件上传到 Slack 频道，支持图片、文档等各种文件类型。
 * 仅允许上传 /workspace/ 下的文件。
 */
export const attachTool: AgentTool<typeof attachSchema> = {
	name: "attach",
	label: "attach",
	description:
		"Attach a file to your response. Use this to share files, images, or documents with the user. Only files from /workspace/ can be attached.",
	parameters: attachSchema,
	execute: async (
		_toolCallId: string,
		{ path, title }: { label: string; path: string; title?: string },
		signal?: AbortSignal,
	) => {
		// 检查上传函数是否已配置
		if (!uploadFn) {
			throw new Error("Upload function not configured");
		}

		// 检查是否已被中止
		if (signal?.aborted) {
			throw new Error("Operation aborted");
		}

		// 解析为绝对路径并确定文件名
		const absolutePath = resolvePath(path);
		const fileName = title || basename(absolutePath);

		// 执行上传
		await uploadFn(absolutePath, fileName);

		return {
			content: [{ type: "text" as const, text: `Attached file: ${fileName}` }],
			details: undefined,
		};
	},
};
