/**
 * @file proxy-utils.ts
 * @description CORS 代理工具函数。
 * 在浏览器环境中，某些 LLM 提供商的 API 不支持跨域请求（CORS），
 * 本模块提供统一的代理决策逻辑、代理应用函数、CORS 错误检测以及流式请求封装。
 */

import type { Api, Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";

/**
 * 判断指定提供商和 API Key 组合是否需要使用 CORS 代理。
 *
 * 决策规则：
 * - zai：始终需要代理
 * - anthropic：仅 OAuth 令牌（sk-ant-oat-*）需要代理，普通 API Key 不需要
 * - openai/google/groq 等：不需要代理
 * - 未知提供商：默认不需要代理
 *
 * @param provider - 提供商名称（如 "anthropic"、"openai"、"zai"）
 * @param apiKey - 该提供商的 API Key
 * @returns 若需要代理返回 true，否则返回 false
 */
export function shouldUseProxyForProvider(provider: string, apiKey: string): boolean {
	switch (provider.toLowerCase()) {
		case "zai":
			// Z-AI always requires proxy
			return true;

		case "anthropic":
			// Anthropic OAuth tokens (sk-ant-oat-*) require proxy
			// Regular API keys (sk-ant-api-*) do NOT require proxy
			return apiKey.startsWith("sk-ant-oat");

		// These providers work without proxy
		case "openai":
		case "google":
		case "groq":
		case "openrouter":
		case "cerebras":
		case "xai":
		case "ollama":
		case "lmstudio":
			return false;

		// Unknown providers - assume no proxy needed
		// This allows new providers to work by default
		default:
			return false;
	}
}

/**
 * 根据需要为模型的 baseUrl 添加 CORS 代理前缀。
 * 若不需要代理或未配置代理 URL，则返回原始模型对象。
 *
 * @param model - 要处理的模型对象
 * @param apiKey - 该提供商的 API Key
 * @param proxyUrl - CORS 代理 URL（如 "https://proxy.mariozechner.at/proxy"）
 * @returns 若需要代理则返回修改了 baseUrl 的模型副本，否则返回原始模型
 */
export function applyProxyIfNeeded<T extends Api>(model: Model<T>, apiKey: string, proxyUrl?: string): Model<T> {
	// If no proxy URL configured, return original model
	if (!proxyUrl) {
		return model;
	}

	// If model has no baseUrl, can't proxy it
	if (!model.baseUrl) {
		return model;
	}

	// Check if this provider/key needs proxy
	if (!shouldUseProxyForProvider(model.provider, apiKey)) {
		return model;
	}

	// Apply proxy to baseUrl
	return {
		...model,
		baseUrl: `${proxyUrl}/?url=${encodeURIComponent(model.baseUrl)}`,
	};
}

/**
 * 判断一个错误是否可能是 CORS 错误。
 *
 * 浏览器中 CORS 错误通常表现为：
 * - TypeError + "Failed to fetch" 消息
 * - NetworkError 类型
 * - 消息中包含 "cors" 或 "cross-origin"
 *
 * @param error - 要检测的错误对象
 * @returns 若可能是 CORS 错误返回 true
 */
export function isCorsError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}

	// Check for common CORS error patterns
	const message = error.message.toLowerCase();

	// "Failed to fetch" is the standard CORS error in most browsers
	if (error.name === "TypeError" && message.includes("failed to fetch")) {
		return true;
	}

	// Some browsers report "NetworkError"
	if (error.name === "NetworkError") {
		return true;
	}

	// CORS-specific messages
	if (message.includes("cors") || message.includes("cross-origin")) {
		return true;
	}

	return false;
}

/**
 * 创建一个支持 CORS 代理的流式请求函数。
 * 每次调用时从存储中读取代理设置，按需为模型添加代理。
 *
 * @param getProxyUrl - 异步函数，返回当前代理 URL（禁用时返回 undefined）
 * @returns 与 Agent 的 streamFn 选项兼容的流式请求函数
 */
export function createStreamFn(getProxyUrl: () => Promise<string | undefined>) {
	return async (model: Model<any>, context: Context, options?: SimpleStreamOptions) => {
		const apiKey = options?.apiKey;
		const proxyUrl = await getProxyUrl();

		if (!apiKey || !proxyUrl) {
			return streamSimple(model, context, options);
		}

		const proxiedModel = applyProxyIfNeeded(model, apiKey, proxyUrl);
		return streamSimple(proxiedModel, context, options);
	};
}
