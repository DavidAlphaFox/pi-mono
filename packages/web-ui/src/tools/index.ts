/**
 * @file tools/index.ts
 * @description 工具渲染系统入口。
 * 注册所有内置工具渲染器，提供统一的 renderTool 函数和 showJsonMode 调试切换。
 */

import type { ToolResultMessage } from "@mariozechner/pi-ai";
import "./javascript-repl.js"; // 副作用导入：自动注册渲染器
import "./extract-document.js"; // 副作用导入：自动注册渲染器
import { getToolRenderer, registerToolRenderer } from "./renderer-registry.js";
import { BashRenderer } from "./renderers/BashRenderer.js";
import { DefaultRenderer } from "./renderers/DefaultRenderer.js";
import type { ToolRenderResult } from "./types.js";

// 注册所有内置工具渲染器
registerToolRenderer("bash", new BashRenderer());

const defaultRenderer = new DefaultRenderer();

// 全局标志：强制所有工具使用默认 JSON 渲染
let showJsonMode = false;

/**
 * 启用或禁用 JSON 显示模式。
 * 启用后所有工具渲染器将使用默认的 JSON 渲染器，便于调试。
 */
export function setShowJsonMode(enabled: boolean): void {
	showJsonMode = enabled;
}

/**
 * 统一的工具渲染函数。
 * 根据工具名称查找对应渲染器，处理参数、结果和流式状态。
 * 若启用了 showJsonMode 或无对应渲染器，则使用默认 JSON 渲染。
 */
export function renderTool(
	toolName: string,
	params: any | undefined,
	result: ToolResultMessage | undefined,
	isStreaming?: boolean,
): ToolRenderResult {
	// If showJsonMode is enabled, always use the default renderer
	if (showJsonMode) {
		return defaultRenderer.render(params, result, isStreaming);
	}

	const renderer = getToolRenderer(toolName);
	if (renderer) {
		return renderer.render(params, result, isStreaming);
	}
	return defaultRenderer.render(params, result, isStreaming);
}

export { getToolRenderer, registerToolRenderer };
