/**
 * @file 简化选项构建工具
 *
 * 本文件提供将 SimpleStreamOptions 转换为各提供商所需的 StreamOptions 的工具函数：
 * - buildBaseOptions()：从简化选项中提取基础流式请求参数
 * - clampReasoning()：将 xhigh 推理级别降级为 high（用于不支持 xhigh 的提供商）
 * - adjustMaxTokensForThinking()：根据推理级别调整最大令牌数和思考预算
 */

import type { Api, Model, SimpleStreamOptions, StreamOptions, ThinkingBudgets, ThinkingLevel } from "../types.js";

/** 从 SimpleStreamOptions 中提取基础流式请求参数，构建 StreamOptions */
export function buildBaseOptions(model: Model<Api>, options?: SimpleStreamOptions, apiKey?: string): StreamOptions {
	return {
		temperature: options?.temperature,
		maxTokens: options?.maxTokens || Math.min(model.maxTokens, 32000),
		signal: options?.signal,
		apiKey: apiKey || options?.apiKey,
		cacheRetention: options?.cacheRetention,
		sessionId: options?.sessionId,
		headers: options?.headers,
		onPayload: options?.onPayload,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		metadata: options?.metadata,
	};
}

/** 将 xhigh 推理级别降级为 high，用于不支持 xhigh 的提供商 */
export function clampReasoning(effort: ThinkingLevel | undefined): Exclude<ThinkingLevel, "xhigh"> | undefined {
	return effort === "xhigh" ? "high" : effort;
}

/**
 * 根据推理级别调整最大令牌数和思考预算。
 * 思考预算会占用部分输出令牌配额，此函数确保总量不超过模型上限，
 * 同时保留至少 1024 个令牌用于实际输出。
 */
export function adjustMaxTokensForThinking(
	baseMaxTokens: number,
	modelMaxTokens: number,
	reasoningLevel: ThinkingLevel,
	customBudgets?: ThinkingBudgets,
): { maxTokens: number; thinkingBudget: number } {
	const defaultBudgets: ThinkingBudgets = {
		minimal: 1024,
		low: 2048,
		medium: 8192,
		high: 16384,
	};
	const budgets = { ...defaultBudgets, ...customBudgets };

	const minOutputTokens = 1024;
	const level = clampReasoning(reasoningLevel)!;
	let thinkingBudget = budgets[level]!;
	const maxTokens = Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);

	if (maxTokens <= thinkingBudget) {
		thinkingBudget = Math.max(0, maxTokens - minOutputTokens);
	}

	return { maxTokens, thinkingBudget };
}
