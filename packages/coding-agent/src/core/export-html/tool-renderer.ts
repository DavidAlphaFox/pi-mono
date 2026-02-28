/**
 * HTML 导出中自定义工具的 HTML 渲染器
 *
 * 本文件通过调用工具的 TUI 渲染器并将 ANSI 输出转换为 HTML，
 * 实现了自定义工具调用和结果的 HTML 渲染。
 */

import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { Theme } from "../../modes/interactive/theme/theme.js";
import type { ToolDefinition } from "../extensions/types.js";
import { ansiLinesToHtml } from "./ansi-to-html.js";

/** 工具 HTML 渲染器的依赖项 */
export interface ToolHtmlRendererDeps {
	/** 按名称查找工具定义的函数 */
	getToolDefinition: (name: string) => ToolDefinition | undefined;
	/** 用于样式的主题 */
	theme: Theme;
	/** 渲染的终端宽度（默认 100） */
	width?: number;
}

/** 工具 HTML 渲染器接口 */
export interface ToolHtmlRenderer {
	/** 将工具调用渲染为 HTML，无自定义渲染器时返回 undefined */
	renderCall(toolName: string, args: unknown): string | undefined;
	/** 将工具结果渲染为 HTML，无自定义渲染器时返回 undefined */
	renderResult(
		toolName: string,
		result: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
		details: unknown,
		isError: boolean,
	): string | undefined;
}

/**
 * 创建工具 HTML 渲染器。
 *
 * 渲染器查找工具定义并调用其 renderCall/renderResult 方法，
 * 将生成的 TUI 组件输出（ANSI 格式）转换为 HTML。
 */
export function createToolHtmlRenderer(deps: ToolHtmlRendererDeps): ToolHtmlRenderer {
	const { getToolDefinition, theme, width = 100 } = deps;

	return {
		renderCall(toolName: string, args: unknown): string | undefined {
			try {
				const toolDef = getToolDefinition(toolName);
				if (!toolDef?.renderCall) {
					return undefined;
				}

				const component = toolDef.renderCall(args, theme);
				const lines = component.render(width);
				return ansiLinesToHtml(lines);
			} catch {
				// On error, return undefined to trigger JSON fallback
				return undefined;
			}
		},

		renderResult(
			toolName: string,
			result: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
			details: unknown,
			isError: boolean,
		): string | undefined {
			try {
				const toolDef = getToolDefinition(toolName);
				if (!toolDef?.renderResult) {
					return undefined;
				}

				// Build AgentToolResult from content array
				// Cast content since session storage uses generic object types
				const agentToolResult = {
					content: result as (TextContent | ImageContent)[],
					details,
					isError,
				};

				// Always render expanded, client-side will apply truncation
				const component = toolDef.renderResult(agentToolResult, { expanded: true, isPartial: false }, theme);
				const lines = component.render(width);
				return ansiLinesToHtml(lines);
			} catch {
				// On error, return undefined to trigger JSON fallback
				return undefined;
			}
		},
	};
}
