/**
 * @file tools/index.ts - 工具集注册入口
 *
 * 本文件负责：
 * 1. 汇总所有 Agent 工具（bash、read、write、edit、attach）
 * 2. 导出 createMomTools 工厂函数，用于创建完整的工具集
 * 3. 重导出 setUploadFunction，供外部设置文件上传回调
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Executor } from "../sandbox.js";
import { attachTool } from "./attach.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";

/** 重导出 setUploadFunction，供 agent.ts 在每次运行前设置上传回调 */
export { setUploadFunction } from "./attach.js";

/**
 * 创建 Mom 的完整工具集
 * 包含：read（读文件）、bash（执行命令）、edit（编辑文件）、write（写文件）、attach（上传文件到 Slack）
 * @param executor - 命令执行器（Host 或 Docker）
 * @returns Agent 工具数组
 */
export function createMomTools(executor: Executor): AgentTool<any>[] {
	return [
		createReadTool(executor),
		createBashTool(executor),
		createEditTool(executor),
		createWriteTool(executor),
		attachTool,
	];
}
