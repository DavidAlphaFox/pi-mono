/**
 * @file 内置 API 提供商注册
 *
 * 本文件负责将所有内置 API 提供商注册到全局注册表中，包括：
 * - Anthropic Messages API（Claude 系列模型）
 * - OpenAI Completions API（GPT 系列、兼容 API）
 * - OpenAI Responses API（GPT-5 等新一代模型）
 * - Azure OpenAI Responses API
 * - OpenAI Codex Responses API（ChatGPT 订阅）
 * - Google Generative AI（Gemini 系列）
 * - Google Gemini CLI / Antigravity（Cloud Code Assist）
 * - Google Vertex AI
 * - Amazon Bedrock（Converse Stream API）
 *
 * 模块加载时自动执行注册。
 */

import { clearApiProviders, registerApiProvider } from "../api-registry.js";
import { streamBedrock, streamSimpleBedrock } from "./amazon-bedrock.js";
import { streamAnthropic, streamSimpleAnthropic } from "./anthropic.js";
import { streamAzureOpenAIResponses, streamSimpleAzureOpenAIResponses } from "./azure-openai-responses.js";
import { streamGoogle, streamSimpleGoogle } from "./google.js";
import { streamGoogleGeminiCli, streamSimpleGoogleGeminiCli } from "./google-gemini-cli.js";
import { streamGoogleVertex, streamSimpleGoogleVertex } from "./google-vertex.js";
import { streamOpenAICodexResponses, streamSimpleOpenAICodexResponses } from "./openai-codex-responses.js";
import { streamOpenAICompletions, streamSimpleOpenAICompletions } from "./openai-completions.js";
import { streamOpenAIResponses, streamSimpleOpenAIResponses } from "./openai-responses.js";

/** 注册所有内置 API 提供商到全局注册表 */
export function registerBuiltInApiProviders(): void {
	registerApiProvider({
		api: "anthropic-messages",
		stream: streamAnthropic,
		streamSimple: streamSimpleAnthropic,
	});

	registerApiProvider({
		api: "openai-completions",
		stream: streamOpenAICompletions,
		streamSimple: streamSimpleOpenAICompletions,
	});

	registerApiProvider({
		api: "openai-responses",
		stream: streamOpenAIResponses,
		streamSimple: streamSimpleOpenAIResponses,
	});

	registerApiProvider({
		api: "azure-openai-responses",
		stream: streamAzureOpenAIResponses,
		streamSimple: streamSimpleAzureOpenAIResponses,
	});

	registerApiProvider({
		api: "openai-codex-responses",
		stream: streamOpenAICodexResponses,
		streamSimple: streamSimpleOpenAICodexResponses,
	});

	registerApiProvider({
		api: "google-generative-ai",
		stream: streamGoogle,
		streamSimple: streamSimpleGoogle,
	});

	registerApiProvider({
		api: "google-gemini-cli",
		stream: streamGoogleGeminiCli,
		streamSimple: streamSimpleGoogleGeminiCli,
	});

	registerApiProvider({
		api: "google-vertex",
		stream: streamGoogleVertex,
		streamSimple: streamSimpleGoogleVertex,
	});

	registerApiProvider({
		api: "bedrock-converse-stream",
		stream: streamBedrock,
		streamSimple: streamSimpleBedrock,
	});
}

/** 重置 API 提供商注册表为内置默认状态 */
export function resetApiProviders(): void {
	clearApiProviders();
	registerBuiltInApiProviders();
}

registerBuiltInApiProviders();
