/**
 * @file 核心类型定义文件
 *
 * 本文件定义了 AI 统一抽象层的所有核心类型，包括：
 * - API 和提供商的类型标识
 * - 流式请求选项（温度、最大令牌数、信号等）
 * - 统一的消息格式（用户消息、助手消息、工具结果消息）
 * - 内容块类型（文本、思考过程、图像、工具调用）
 * - 用量和成本统计
 * - 模型定义接口
 * - 兼容性配置（OpenAI 兼容、OpenRouter 路由等）
 */

import type { AssistantMessageEventStream } from "./utils/event-stream.js";

export type { AssistantMessageEventStream } from "./utils/event-stream.js";

/** 已知的 API 协议标识，每种协议对应一种特定的 API 通信格式 */
export type KnownApi =
	| "openai-completions"
	| "openai-responses"
	| "azure-openai-responses"
	| "openai-codex-responses"
	| "anthropic-messages"
	| "bedrock-converse-stream"
	| "google-generative-ai"
	| "google-gemini-cli"
	| "google-vertex";

/** API 类型，可以是已知 API 或自定义字符串 */
export type Api = KnownApi | (string & {});

/** 已知的提供商标识，涵盖 20+ 主流 AI 服务提供商 */
export type KnownProvider =
	| "amazon-bedrock"
	| "anthropic"
	| "google"
	| "google-gemini-cli"
	| "google-antigravity"
	| "google-vertex"
	| "openai"
	| "azure-openai-responses"
	| "openai-codex"
	| "github-copilot"
	| "xai"
	| "groq"
	| "cerebras"
	| "openrouter"
	| "vercel-ai-gateway"
	| "zai"
	| "mistral"
	| "minimax"
	| "minimax-cn"
	| "huggingface"
	| "opencode"
	| "kimi-coding";
/** 提供商类型，可以是已知提供商或自定义字符串 */
export type Provider = KnownProvider | string;

/** 思考深度级别，控制模型推理的深度（从 minimal 到 xhigh） */
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

/** 各思考级别的令牌预算（仅适用于基于令牌的提供商） */
export interface ThinkingBudgets {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

/** 缓存保留策略：none 不缓存，short 短期缓存，long 长期缓存 */
export type CacheRetention = "none" | "short" | "long";

/** 传输协议类型：SSE 服务器推送事件、WebSocket 或自动选择 */
export type Transport = "sse" | "websocket" | "auto";

/** 所有提供商共享的基础流式请求选项 */
export interface StreamOptions {
	temperature?: number;
	maxTokens?: number;
	signal?: AbortSignal;
	apiKey?: string;
	/**
	 * Preferred transport for providers that support multiple transports.
	 * Providers that do not support this option ignore it.
	 */
	transport?: Transport;
	/**
	 * Prompt cache retention preference. Providers map this to their supported values.
	 * Default: "short".
	 */
	cacheRetention?: CacheRetention;
	/**
	 * Optional session identifier for providers that support session-based caching.
	 * Providers can use this to enable prompt caching, request routing, or other
	 * session-aware features. Ignored by providers that don't support it.
	 */
	sessionId?: string;
	/**
	 * Optional callback for inspecting provider payloads before sending.
	 */
	onPayload?: (payload: unknown) => void;
	/**
	 * Optional custom HTTP headers to include in API requests.
	 * Merged with provider defaults; can override default headers.
	 * Not supported by all providers (e.g., AWS Bedrock uses SDK auth).
	 */
	headers?: Record<string, string>;
	/**
	 * Maximum delay in milliseconds to wait for a retry when the server requests a long wait.
	 * If the server's requested delay exceeds this value, the request fails immediately
	 * with an error containing the requested delay, allowing higher-level retry logic
	 * to handle it with user visibility.
	 * Default: 60000 (60 seconds). Set to 0 to disable the cap.
	 */
	maxRetryDelayMs?: number;
	/**
	 * Optional metadata to include in API requests.
	 * Providers extract the fields they understand and ignore the rest.
	 * For example, Anthropic uses `user_id` for abuse tracking and rate limiting.
	 */
	metadata?: Record<string, unknown>;
}

/** 提供商级别的流式选项，允许传入提供商特定的额外字段 */
export type ProviderStreamOptions = StreamOptions & Record<string, unknown>;

/** 简化的统一流式选项，包含推理级别配置，用于 streamSimple() 和 completeSimple() */
export interface SimpleStreamOptions extends StreamOptions {
	reasoning?: ThinkingLevel;
	/** Custom token budgets for thinking levels (token-based providers only) */
	thinkingBudgets?: ThinkingBudgets;
}

/** 通用的流式处理函数类型，支持泛型 API 和选项类型 */
export type StreamFunction<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> = (
	model: Model<TApi>,
	context: Context,
	options?: TOptions,
) => AssistantMessageEventStream;

/** 文本内容块 */
export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string; // 文本签名，例如 OpenAI Responses API 的消息 ID
}

/** 思考/推理内容块，包含模型的内部推理过程 */
export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string; // 思考签名，例如 OpenAI Responses API 的推理项 ID
	/** When true, the thinking content was redacted by safety filters. The opaque
	 *  encrypted payload is stored in `thinkingSignature` so it can be passed back
	 *  to the API for multi-turn continuity. */
	redacted?: boolean;
}

/** 图像内容块 */
export interface ImageContent {
	type: "image";
	data: string; // base64 编码的图像数据
	mimeType: string; // MIME 类型，如 "image/jpeg"、"image/png"
}

/** 工具调用块，表示模型请求调用一个外部工具 */
export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, any>;
	thoughtSignature?: string; // Google 特有：用于复用思考上下文的不透明签名
}

/** 令牌使用量统计，包含输入、输出、缓存读写及对应成本 */
export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

/** 停止原因：正常结束、长度限制、工具调用、错误或被中止 */
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

/** 用户消息 */
export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp: number; // Unix timestamp in milliseconds
}

/** 助手（模型）响应消息，包含内容块、用量统计和停止原因 */
export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	api: Api;
	provider: Provider;
	model: string;
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	timestamp: number; // Unix timestamp in milliseconds
}

/** 工具执行结果消息，包含工具输出内容和错误状态 */
export interface ToolResultMessage<TDetails = any> {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[]; // Supports text and images
	details?: TDetails;
	isError: boolean;
	timestamp: number; // Unix timestamp in milliseconds
}

/** 消息联合类型，可以是用户消息、助手消息或工具结果消息 */
export type Message = UserMessage | AssistantMessage | ToolResultMessage;

import type { TSchema } from "@sinclair/typebox";

/** 工具定义，包含名称、描述和 JSON Schema 参数定义 */
export interface Tool<TParameters extends TSchema = TSchema> {
	name: string;
	description: string;
	parameters: TParameters;
}

/** 请求上下文，包含系统提示词、消息历史和可用工具列表 */
export interface Context {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];
}

/** 助手消息流式事件类型，表示流式响应中的各种事件（开始、文本增量、工具调用等） */
export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| { type: "done"; reason: Extract<StopReason, "stop" | "length" | "toolUse">; message: AssistantMessage }
	| { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };

/**
 * Compatibility settings for OpenAI-compatible completions APIs.
 * Use this to override URL-based auto-detection for custom providers.
 */
export interface OpenAICompletionsCompat {
	/** Whether the provider supports the `store` field. Default: auto-detected from URL. */
	supportsStore?: boolean;
	/** Whether the provider supports the `developer` role (vs `system`). Default: auto-detected from URL. */
	supportsDeveloperRole?: boolean;
	/** Whether the provider supports `reasoning_effort`. Default: auto-detected from URL. */
	supportsReasoningEffort?: boolean;
	/** Whether the provider supports `stream_options: { include_usage: true }` for token usage in streaming responses. Default: true. */
	supportsUsageInStreaming?: boolean;
	/** Which field to use for max tokens. Default: auto-detected from URL. */
	maxTokensField?: "max_completion_tokens" | "max_tokens";
	/** Whether tool results require the `name` field. Default: auto-detected from URL. */
	requiresToolResultName?: boolean;
	/** Whether a user message after tool results requires an assistant message in between. Default: auto-detected from URL. */
	requiresAssistantAfterToolResult?: boolean;
	/** Whether thinking blocks must be converted to text blocks with <thinking> delimiters. Default: auto-detected from URL. */
	requiresThinkingAsText?: boolean;
	/** Whether tool call IDs must be normalized to Mistral format (exactly 9 alphanumeric chars). Default: auto-detected from URL. */
	requiresMistralToolIds?: boolean;
	/** Format for reasoning/thinking parameter. "openai" uses reasoning_effort, "zai" uses thinking: { type: "enabled" }, "qwen" uses enable_thinking: boolean. Default: "openai". */
	thinkingFormat?: "openai" | "zai" | "qwen";
	/** OpenRouter-specific routing preferences. Only used when baseUrl points to OpenRouter. */
	openRouterRouting?: OpenRouterRouting;
	/** Vercel AI Gateway routing preferences. Only used when baseUrl points to Vercel AI Gateway. */
	vercelGatewayRouting?: VercelGatewayRouting;
	/** Whether the provider supports the `strict` field in tool definitions. Default: true. */
	supportsStrictMode?: boolean;
}

/** Compatibility settings for OpenAI Responses APIs. */
export interface OpenAIResponsesCompat {
	// Reserved for future use
}

/**
 * OpenRouter provider routing preferences.
 * Controls which upstream providers OpenRouter routes requests to.
 * @see https://openrouter.ai/docs/provider-routing
 */
export interface OpenRouterRouting {
	/** List of provider slugs to exclusively use for this request (e.g., ["amazon-bedrock", "anthropic"]). */
	only?: string[];
	/** List of provider slugs to try in order (e.g., ["anthropic", "openai"]). */
	order?: string[];
}

/**
 * Vercel AI Gateway routing preferences.
 * Controls which upstream providers the gateway routes requests to.
 * @see https://vercel.com/docs/ai-gateway/models-and-providers/provider-options
 */
export interface VercelGatewayRouting {
	/** List of provider slugs to exclusively use for this request (e.g., ["bedrock", "anthropic"]). */
	only?: string[];
	/** List of provider slugs to try in order (e.g., ["anthropic", "openai"]). */
	order?: string[];
}

/** 统一模型接口，定义模型的所有属性（ID、提供商、成本、上下文窗口等） */
export interface Model<TApi extends Api> {
	id: string;
	name: string;
	api: TApi;
	provider: Provider;
	baseUrl: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: {
		input: number; // $/million tokens
		output: number; // $/million tokens
		cacheRead: number; // $/million tokens
		cacheWrite: number; // $/million tokens
	};
	contextWindow: number;
	maxTokens: number;
	headers?: Record<string, string>;
	/** Compatibility overrides for OpenAI-compatible APIs. If not set, auto-detected from baseUrl. */
	compat?: TApi extends "openai-completions"
		? OpenAICompletionsCompat
		: TApi extends "openai-responses"
			? OpenAIResponsesCompat
			: never;
}
