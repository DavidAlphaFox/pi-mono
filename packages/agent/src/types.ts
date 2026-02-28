/**
 * @file 智能体核心类型定义
 *
 * 本文件定义了智能体系统的所有核心类型，包括：
 * - AgentLoopConfig: 智能体循环的配置接口
 * - AgentMessage: 可扩展的消息联合类型，支持 LLM 消息和自定义消息
 * - AgentState: 智能体运行时的完整状态
 * - AgentTool: 可执行的工具接口，扩展自基础 Tool
 * - AgentEvent: 智能体生命周期事件，用于 UI 更新和状态同步
 *
 * 类型设计遵循可扩展原则，应用层可通过 TypeScript 声明合并
 * 来注入自定义消息类型，同时保持与底层 LLM 消息的兼容性。
 */

import type {
	AssistantMessageEvent,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	streamSimple,
	TextContent,
	Tool,
	ToolResultMessage,
} from "@mariozechner/pi-ai";
import type { Static, TSchema } from "@sinclair/typebox";

/**
 * 流式调用函数类型
 *
 * 与 streamSimple 具有相同的参数签名，但返回值可以是同步或异步的，
 * 以支持需要异步配置查找（如动态 API 密钥）的场景。
 */
export type StreamFn = (
	...args: Parameters<typeof streamSimple>
) => ReturnType<typeof streamSimple> | Promise<ReturnType<typeof streamSimple>>;

/**
 * 智能体循环配置接口
 *
 * 继承自 SimpleStreamOptions，提供 LLM 流式调用的基础配置，
 * 并扩展了智能体特有的消息转换、上下文变换和中断控制能力。
 */
export interface AgentLoopConfig extends SimpleStreamOptions {
	/** 当前使用的 LLM 模型 */
	model: Model<any>;

	/**
	 * 将 AgentMessage[] 转换为 LLM 兼容的 Message[]，在每次 LLM 调用前执行。
	 *
	 * 每个 AgentMessage 必须被转换为 UserMessage、AssistantMessage 或 ToolResultMessage，
	 * 以供 LLM 理解。无法转换的 AgentMessage（如纯 UI 通知、状态消息）应被过滤掉。
	 *
	 * @example
	 * ```typescript
	 * convertToLlm: (messages) => messages.flatMap(m => {
	 *   if (m.role === "custom") {
	 *     // 将自定义消息转换为用户消息
	 *     return [{ role: "user", content: m.content, timestamp: m.timestamp }];
	 *   }
	 *   if (m.role === "notification") {
	 *     // 过滤掉纯 UI 消息
	 *     return [];
	 *   }
	 *   // 透传标准 LLM 消息
	 *   return [m];
	 * })
	 * ```
	 */
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	/**
	 * 可选的上下文变换函数，在 `convertToLlm` 之前执行。
	 *
	 * 用于在 AgentMessage 层面进行操作：
	 * - 上下文窗口管理（裁剪旧消息以控制 token 用量）
	 * - 从外部来源注入上下文信息
	 *
	 * @example
	 * ```typescript
	 * transformContext: async (messages) => {
	 *   if (estimateTokens(messages) > MAX_TOKENS) {
	 *     return pruneOldMessages(messages);
	 *   }
	 *   return messages;
	 * }
	 * ```
	 */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	/**
	 * 动态解析 API 密钥，在每次 LLM 调用时执行。
	 *
	 * 适用于短期有效的 OAuth 令牌（如 GitHub Copilot），
	 * 这些令牌可能在长时间的工具执行阶段过期。
	 */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	/**
	 * 获取干预消息，用于在运行中途注入到对话中。
	 *
	 * 在每次工具执行后调用，检查是否有用户中断。
	 * 如果返回了消息，则跳过剩余的工具调用，
	 * 并将这些消息添加到上下文中，在下一次 LLM 调用前使用。
	 *
	 * 用于在智能体工作时"引导"其方向。
	 */
	getSteeringMessages?: () => Promise<AgentMessage[]>;

	/**
	 * 获取后续跟进消息，在智能体即将停止时处理。
	 *
	 * 当智能体没有更多工具调用且没有干预消息时调用。
	 * 如果返回了消息，这些消息会被添加到上下文中，
	 * 智能体将继续进行下一轮对话。
	 *
	 * 用于需要等待智能体完成后才发送的跟进消息。
	 */
	getFollowUpMessages?: () => Promise<AgentMessage[]>;
}

/**
 * 模型思考/推理级别
 *
 * 控制支持推理功能的模型的思考深度。
 * 注意："xhigh" 仅支持 OpenAI gpt-5.1-codex-max、gpt-5.2、gpt-5.2-codex、
 * gpt-5.3 和 gpt-5.3-codex 模型。
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * 自定义智能体消息的可扩展接口
 *
 * 应用层可通过 TypeScript 声明合并来注册自定义消息类型：
 *
 * @example
 * ```typescript
 * declare module "@mariozechner/agent" {
 *   interface CustomAgentMessages {
 *     artifact: ArtifactMessage;
 *     notification: NotificationMessage;
 *   }
 * }
 * ```
 */
export interface CustomAgentMessages {
	// 默认为空 - 应用层通过声明合并扩展
}

/**
 * 智能体消息联合类型
 *
 * 由标准 LLM 消息和自定义消息组成的联合类型。
 * 这一抽象允许应用添加自定义消息类型，同时保持
 * 类型安全和与底层 LLM 消息的兼容性。
 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

/**
 * 智能体状态接口
 *
 * 包含智能体运行所需的所有配置和对话数据，
 * 包括系统提示词、模型配置、工具列表、消息历史和流式状态等。
 */
export interface AgentState {
	/** 系统提示词 */
	systemPrompt: string;
	/** 当前使用的 LLM 模型 */
	model: Model<any>;
	/** 思考/推理级别 */
	thinkingLevel: ThinkingLevel;
	/** 注册的工具列表 */
	tools: AgentTool<any>[];
	/** 消息历史（可包含附件和自定义消息类型） */
	messages: AgentMessage[];
	/** 是否正在流式处理中 */
	isStreaming: boolean;
	/** 当前正在流式传输的消息（部分完成） */
	streamMessage: AgentMessage | null;
	/** 正在执行中的工具调用 ID 集合 */
	pendingToolCalls: Set<string>;
	/** 错误信息（如有） */
	error?: string;
}

/**
 * 工具执行结果接口
 *
 * @template T - details 字段的类型，用于在 UI 中展示或记录日志
 */
export interface AgentToolResult<T> {
	/** 内容块列表，支持文本和图片 */
	content: (TextContent | ImageContent)[];
	/** 供 UI 展示或日志记录的详细信息 */
	details: T;
}

/**
 * 工具执行过程中的流式更新回调类型
 *
 * 在工具执行期间被调用，用于报告部分结果以实现实时 UI 更新。
 *
 * @template T - 部分结果的详细信息类型
 */
export type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;

/**
 * 智能体工具接口
 *
 * 扩展自基础 Tool 接口，添加了 execute 执行函数和 UI 展示用的 label。
 * 工具通过 JSON Schema（TypeBox）定义参数类型，在执行前会进行参数校验。
 *
 * @template TParameters - 工具参数的 TypeBox 模式类型
 * @template TDetails - 工具执行结果中 details 字段的类型
 */
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
	/** 工具的人类可读标签，用于 UI 展示 */
	label: string;
	/**
	 * 执行工具调用
	 *
	 * @param toolCallId - 工具调用的唯一标识符
	 * @param params - 经过校验的工具参数
	 * @param signal - 可选的中止信号，用于取消执行
	 * @param onUpdate - 可选的流式更新回调，用于报告部分结果
	 * @returns 工具执行的最终结果
	 */
	execute: (
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
}

/**
 * 智能体上下文接口
 *
 * 类似于 LLM 层的 Context，但使用 AgentTool 和 AgentMessage，
 * 提供更丰富的工具执行和消息类型支持。
 */
export interface AgentContext {
	/** 系统提示词 */
	systemPrompt: string;
	/** 对话消息列表 */
	messages: AgentMessage[];
	/** 可用的工具列表 */
	tools?: AgentTool<any>[];
}

/**
 * 智能体事件联合类型
 *
 * 由智能体发出的事件，用于 UI 更新和状态同步。
 * 这些事件提供了消息、对话轮次和工具执行的细粒度生命周期信息。
 *
 * 事件类别：
 * - agent_start/agent_end: 智能体整体生命周期
 * - turn_start/turn_end: 对话轮次生命周期（一次助手响应 + 相关工具调用/结果）
 * - message_start/message_update/message_end: 消息生命周期
 * - tool_execution_start/update/end: 工具执行生命周期
 */
export type AgentEvent =
	// 智能体生命周期
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	// 对话轮次生命周期 - 一个轮次包含一次助手响应及其工具调用/结果
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	// 消息生命周期 - 用户消息、助手消息和工具结果消息均会触发
	| { type: "message_start"; message: AgentMessage }
	// 仅在流式传输助手消息时触发
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	// 工具执行生命周期
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
