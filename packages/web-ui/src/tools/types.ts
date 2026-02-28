/**
 * @file tools/types.ts
 * @description 工具渲染系统的类型定义。
 * 定义 ToolRenderResult（渲染结果）和 ToolRenderer（渲染器）接口。
 */

import type { ToolResultMessage } from "@mariozechner/pi-ai";
import type { TemplateResult } from "lit";

/** 工具渲染结果 */
export interface ToolRenderResult {
	content: TemplateResult;
	/** true 表示自定义布局（无卡片包裹），false 表示使用默认卡片包裹 */
	isCustom: boolean;
}

/**
 * 工具渲染器接口。
 * @template TParams - 工具参数类型
 * @template TDetails - 工具结果详情类型
 */
export interface ToolRenderer<TParams = any, TDetails = any> {
	render(
		params: TParams | undefined,
		result: ToolResultMessage<TDetails> | undefined,
		isStreaming?: boolean,
	): ToolRenderResult;
}
