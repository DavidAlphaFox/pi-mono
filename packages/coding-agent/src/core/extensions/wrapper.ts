/**
 * 扩展的工具包装器
 *
 * 本文件提供了将扩展注册的工具和内置工具与扩展事件系统集成的包装函数：
 * 1. wrapRegisteredTool：将扩展注册的 RegisteredTool 包装为 AgentTool
 * 2. wrapToolWithExtensions：为工具添加扩展回调（tool_call 拦截和 tool_result 修改）
 * 3. wrapToolsWithExtensions：批量包装工具
 */

import type { AgentTool, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { ExtensionRunner } from "./runner.js";
import type { RegisteredTool, ToolCallEventResult } from "./types.js";

/**
 * 将扩展注册的 RegisteredTool 包装为 AgentTool。
 * 使用 runner 的 createContext() 确保工具和事件处理器间上下文一致。
 */
export function wrapRegisteredTool(registeredTool: RegisteredTool, runner: ExtensionRunner): AgentTool {
	const { definition } = registeredTool;
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		execute: (toolCallId, params, signal, onUpdate) =>
			definition.execute(toolCallId, params, signal, onUpdate, runner.createContext()),
	};
}

/**
 * 将所有扩展注册的工具批量包装为 AgentTool。
 * 使用 runner 的 createContext() 确保工具和事件处理器间上下文一致。
 */
export function wrapRegisteredTools(registeredTools: RegisteredTool[], runner: ExtensionRunner): AgentTool[] {
	return registeredTools.map((rt) => wrapRegisteredTool(rt, runner));
}

/**
 * 为工具添加扩展回调以实现拦截功能。
 * - 执行前发送 tool_call 事件（可阻止执行）
 * - 执行后发送 tool_result 事件（可修改结果）
 */
export function wrapToolWithExtensions<T>(tool: AgentTool<any, T>, runner: ExtensionRunner): AgentTool<any, T> {
	return {
		...tool,
		execute: async (
			toolCallId: string,
			params: Record<string, unknown>,
			signal?: AbortSignal,
			onUpdate?: AgentToolUpdateCallback<T>,
		) => {
			// Emit tool_call event - extensions can block execution
			if (runner.hasHandlers("tool_call")) {
				try {
					const callResult = (await runner.emitToolCall({
						type: "tool_call",
						toolName: tool.name,
						toolCallId,
						input: params,
					})) as ToolCallEventResult | undefined;

					if (callResult?.block) {
						const reason = callResult.reason || "Tool execution was blocked by an extension";
						throw new Error(reason);
					}
				} catch (err) {
					if (err instanceof Error) {
						throw err;
					}
					throw new Error(`Extension failed, blocking execution: ${String(err)}`);
				}
			}

			// Execute the actual tool
			try {
				const result = await tool.execute(toolCallId, params, signal, onUpdate);

				// Emit tool_result event - extensions can modify the result
				if (runner.hasHandlers("tool_result")) {
					const resultResult = await runner.emitToolResult({
						type: "tool_result",
						toolName: tool.name,
						toolCallId,
						input: params,
						content: result.content,
						details: result.details,
						isError: false,
					});

					if (resultResult) {
						return {
							content: resultResult.content ?? result.content,
							details: (resultResult.details ?? result.details) as T,
						};
					}
				}

				return result;
			} catch (err) {
				// Emit tool_result event for errors
				if (runner.hasHandlers("tool_result")) {
					await runner.emitToolResult({
						type: "tool_result",
						toolName: tool.name,
						toolCallId,
						input: params,
						content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
						details: undefined,
						isError: true,
					});
				}
				throw err;
			}
		},
	};
}

/**
 * 为所有工具批量添加扩展回调。
 */
export function wrapToolsWithExtensions<T>(tools: AgentTool<any, T>[], runner: ExtensionRunner): AgentTool<any, T>[] {
	return tools.map((tool) => wrapToolWithExtensions(tool, runner));
}
