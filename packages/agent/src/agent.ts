/**
 * @file 有状态的 Agent 类
 *
 * 本文件实现了核心的 Agent 类，封装了智能体的完整生命周期管理。
 * Agent 类直接使用 agent-loop 进行 LLM 调用，不引入额外的传输抽象层。
 *
 * 主要职责：
 * - 管理智能体状态（消息历史、流式状态、工具列表等）
 * - 提供消息排队机制（干预消息和跟进消息）
 * - 处理 prompt 发送、中止和重试流程
 * - 通过事件订阅机制向 UI 层推送状态更新
 *
 * Agent 类是应用层与智能体循环之间的桥梁，提供了简洁的命令式 API。
 */

import {
	getModel,
	type ImageContent,
	type Message,
	type Model,
	streamSimple,
	type TextContent,
	type ThinkingBudgets,
	type Transport,
} from "@mariozechner/pi-ai";
import { agentLoop, agentLoopContinue } from "./agent-loop.js";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentState,
	AgentTool,
	StreamFn,
	ThinkingLevel,
} from "./types.js";

/**
 * 默认的消息转换函数
 *
 * 仅保留 LLM 兼容的消息类型（user、assistant、toolResult），
 * 过滤掉所有自定义消息类型。
 *
 * @param messages - 待转换的智能体消息列表
 * @returns LLM 兼容的消息列表
 */
function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult");
}

/**
 * Agent 构造选项接口
 *
 * 提供 Agent 实例化时的所有可配置项，包括初始状态、
 * 消息转换函数、排队模式、流式函数和各种运行时选项。
 */
export interface AgentOptions {
	/** 可选的初始状态覆盖 */
	initialState?: Partial<AgentState>;

	/**
	 * 将 AgentMessage[] 转换为 LLM 兼容的 Message[]，在每次 LLM 调用前执行。
	 * 默认行为：过滤保留 user/assistant/toolResult 消息并转换附件。
	 */
	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	/**
	 * 可选的上下文变换函数，在 convertToLlm 之前执行。
	 * 用于上下文裁剪、注入外部上下文等操作。
	 */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	/**
	 * 干预消息的分发模式
	 * - "all": 一次性发送所有干预消息
	 * - "one-at-a-time": 每轮只发送一条干预消息
	 */
	steeringMode?: "all" | "one-at-a-time";

	/**
	 * 跟进消息的分发模式
	 * - "all": 一次性发送所有跟进消息
	 * - "one-at-a-time": 每轮只发送一条跟进消息
	 */
	followUpMode?: "all" | "one-at-a-time";

	/**
	 * 自定义流式调用函数（用于代理后端等场景）。
	 * 默认使用 streamSimple。
	 */
	streamFn?: StreamFn;

	/**
	 * 可选的会话标识符，转发给 LLM 提供商。
	 * 用于支持基于会话的缓存（如 OpenAI Codex）。
	 */
	sessionId?: string;

	/**
	 * 动态解析 API 密钥，在每次 LLM 调用时执行。
	 * 适用于会过期的令牌（如 GitHub Copilot OAuth）。
	 */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	/**
	 * 自定义思考级别的 token 预算（仅适用于基于 token 的提供商）。
	 */
	thinkingBudgets?: ThinkingBudgets;

	/**
	 * 首选传输方式，用于支持多种传输方式的提供商。
	 */
	transport?: Transport;

	/**
	 * 服务器请求重试时的最大等待延迟（毫秒）。
	 * 如果服务器请求的延迟超过此值，请求将立即失败，
	 * 交由上层重试逻辑处理以保持用户可见性。
	 * 默认值：60000（60 秒）。设为 0 可禁用上限。
	 */
	maxRetryDelayMs?: number;
}

/**
 * 有状态的智能体类
 *
 * Agent 是智能体系统的核心入口，封装了完整的对话管理、
 * 工具执行和事件发布功能。通过事件订阅机制，UI 层可以
 * 实时获取智能体的运行状态。
 *
 * 主要 API：
 * - prompt(): 发送消息并启动智能体循环
 * - steer(): 在运行中排队干预消息
 * - followUp(): 排队跟进消息（等待智能体完成后处理）
 * - abort(): 中止当前运行
 * - subscribe(): 订阅智能体事件
 *
 * @example
 * ```typescript
 * const agent = new Agent({
 *   initialState: { systemPrompt: "你是一个助手", model: myModel },
 * });
 * agent.subscribe((event) => console.log(event.type));
 * await agent.prompt("你好");
 * ```
 */
export class Agent {
	/** 智能体的内部状态 */
	private _state: AgentState = {
		systemPrompt: "",
		model: getModel("google", "gemini-2.5-flash-lite-preview-06-17"),
		thinkingLevel: "off",
		tools: [],
		messages: [],
		isStreaming: false,
		streamMessage: null,
		pendingToolCalls: new Set<string>(),
		error: undefined,
	};

	/** 事件监听器集合 */
	private listeners = new Set<(e: AgentEvent) => void>();
	/** 用于中止当前运行的控制器 */
	private abortController?: AbortController;
	/** 消息转换函数：AgentMessage[] → Message[] */
	private convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	/** 可选的上下文变换函数 */
	private transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	/** 干预消息队列 */
	private steeringQueue: AgentMessage[] = [];
	/** 跟进消息队列 */
	private followUpQueue: AgentMessage[] = [];
	/** 干预消息的分发模式 */
	private steeringMode: "all" | "one-at-a-time";
	/** 跟进消息的分发模式 */
	private followUpMode: "all" | "one-at-a-time";
	/** 流式调用函数 */
	public streamFn: StreamFn;
	/** 会话 ID */
	private _sessionId?: string;
	/** 动态 API 密钥解析函数 */
	public getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	/** 当前运行中的 prompt Promise，用于 waitForIdle */
	private runningPrompt?: Promise<void>;
	/** 用于解决 runningPrompt 的回调 */
	private resolveRunningPrompt?: () => void;
	/** 自定义思考预算 */
	private _thinkingBudgets?: ThinkingBudgets;
	/** 首选传输方式 */
	private _transport: Transport;
	/** 最大重试等待延迟 */
	private _maxRetryDelayMs?: number;

	/**
	 * 创建一个新的 Agent 实例
	 *
	 * @param opts - 构造选项，所有字段均为可选
	 */
	constructor(opts: AgentOptions = {}) {
		this._state = { ...this._state, ...opts.initialState };
		this.convertToLlm = opts.convertToLlm || defaultConvertToLlm;
		this.transformContext = opts.transformContext;
		this.steeringMode = opts.steeringMode || "one-at-a-time";
		this.followUpMode = opts.followUpMode || "one-at-a-time";
		this.streamFn = opts.streamFn || streamSimple;
		this._sessionId = opts.sessionId;
		this.getApiKey = opts.getApiKey;
		this._thinkingBudgets = opts.thinkingBudgets;
		this._transport = opts.transport ?? "sse";
		this._maxRetryDelayMs = opts.maxRetryDelayMs;
	}

	/**
	 * 获取当前会话 ID（用于提供商缓存）
	 */
	get sessionId(): string | undefined {
		return this._sessionId;
	}

	/**
	 * 设置会话 ID（用于提供商缓存）
	 * 在切换会话（新会话、分支、恢复）时调用。
	 */
	set sessionId(value: string | undefined) {
		this._sessionId = value;
	}

	/**
	 * 获取当前思考预算配置
	 */
	get thinkingBudgets(): ThinkingBudgets | undefined {
		return this._thinkingBudgets;
	}

	/**
	 * 设置自定义思考预算（用于基于 token 的提供商）
	 */
	set thinkingBudgets(value: ThinkingBudgets | undefined) {
		this._thinkingBudgets = value;
	}

	/**
	 * 获取当前首选传输方式
	 */
	get transport(): Transport {
		return this._transport;
	}

	/**
	 * 设置首选传输方式
	 */
	setTransport(value: Transport) {
		this._transport = value;
	}

	/**
	 * 获取当前最大重试等待延迟（毫秒）
	 */
	get maxRetryDelayMs(): number | undefined {
		return this._maxRetryDelayMs;
	}

	/**
	 * 设置最大重试等待延迟
	 * 设为 0 可禁用上限。
	 */
	set maxRetryDelayMs(value: number | undefined) {
		this._maxRetryDelayMs = value;
	}

	/**
	 * 获取当前智能体状态（只读）
	 */
	get state(): AgentState {
		return this._state;
	}

	/**
	 * 订阅智能体事件
	 *
	 * @param fn - 事件处理回调函数
	 * @returns 取消订阅函数
	 */
	subscribe(fn: (e: AgentEvent) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	// ==================== 状态修改方法 ====================

	/**
	 * 设置系统提示词
	 */
	setSystemPrompt(v: string) {
		this._state.systemPrompt = v;
	}

	/**
	 * 设置 LLM 模型
	 */
	setModel(m: Model<any>) {
		this._state.model = m;
	}

	/**
	 * 设置思考/推理级别
	 */
	setThinkingLevel(l: ThinkingLevel) {
		this._state.thinkingLevel = l;
	}

	/**
	 * 设置干预消息的分发模式
	 */
	setSteeringMode(mode: "all" | "one-at-a-time") {
		this.steeringMode = mode;
	}

	/**
	 * 获取当前干预消息的分发模式
	 */
	getSteeringMode(): "all" | "one-at-a-time" {
		return this.steeringMode;
	}

	/**
	 * 设置跟进消息的分发模式
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time") {
		this.followUpMode = mode;
	}

	/**
	 * 获取当前跟进消息的分发模式
	 */
	getFollowUpMode(): "all" | "one-at-a-time" {
		return this.followUpMode;
	}

	/**
	 * 设置可用的工具列表
	 */
	setTools(t: AgentTool<any>[]) {
		this._state.tools = t;
	}

	/**
	 * 替换所有消息（创建浅拷贝）
	 */
	replaceMessages(ms: AgentMessage[]) {
		this._state.messages = ms.slice();
	}

	/**
	 * 追加一条消息到消息历史末尾
	 */
	appendMessage(m: AgentMessage) {
		this._state.messages = [...this._state.messages, m];
	}

	/**
	 * 排队一条干预消息，用于在智能体运行中途中断。
	 * 该消息会在当前工具执行完成后送达，并跳过剩余的工具调用。
	 */
	steer(m: AgentMessage) {
		this.steeringQueue.push(m);
	}

	/**
	 * 排队一条跟进消息，在智能体完成后处理。
	 * 仅当智能体没有更多工具调用或干预消息时才会送达。
	 */
	followUp(m: AgentMessage) {
		this.followUpQueue.push(m);
	}

	/**
	 * 清空干预消息队列
	 */
	clearSteeringQueue() {
		this.steeringQueue = [];
	}

	/**
	 * 清空跟进消息队列
	 */
	clearFollowUpQueue() {
		this.followUpQueue = [];
	}

	/**
	 * 清空所有消息队列（干预 + 跟进）
	 */
	clearAllQueues() {
		this.steeringQueue = [];
		this.followUpQueue = [];
	}

	/**
	 * 检查是否有排队中的消息
	 */
	hasQueuedMessages(): boolean {
		return this.steeringQueue.length > 0 || this.followUpQueue.length > 0;
	}

	/**
	 * 从干预队列中取出消息
	 * 根据分发模式返回一条或全部消息。
	 */
	private dequeueSteeringMessages(): AgentMessage[] {
		if (this.steeringMode === "one-at-a-time") {
			// 逐条模式：只取出队列中的第一条消息
			if (this.steeringQueue.length > 0) {
				const first = this.steeringQueue[0];
				this.steeringQueue = this.steeringQueue.slice(1);
				return [first];
			}
			return [];
		}

		// 全部模式：取出队列中的所有消息
		const steering = this.steeringQueue.slice();
		this.steeringQueue = [];
		return steering;
	}

	/**
	 * 从跟进队列中取出消息
	 * 根据分发模式返回一条或全部消息。
	 */
	private dequeueFollowUpMessages(): AgentMessage[] {
		if (this.followUpMode === "one-at-a-time") {
			// 逐条模式：只取出队列中的第一条消息
			if (this.followUpQueue.length > 0) {
				const first = this.followUpQueue[0];
				this.followUpQueue = this.followUpQueue.slice(1);
				return [first];
			}
			return [];
		}

		// 全部模式：取出队列中的所有消息
		const followUp = this.followUpQueue.slice();
		this.followUpQueue = [];
		return followUp;
	}

	/**
	 * 清空所有消息历史
	 */
	clearMessages() {
		this._state.messages = [];
	}

	/**
	 * 中止当前正在进行的智能体运行
	 */
	abort() {
		this.abortController?.abort();
	}

	/**
	 * 等待智能体进入空闲状态
	 * 如果智能体正在运行，返回运行中的 Promise；否则立即解决。
	 */
	waitForIdle(): Promise<void> {
		return this.runningPrompt ?? Promise.resolve();
	}

	/**
	 * 重置智能体状态
	 * 清空消息历史、流式状态、待处理工具调用、错误和所有消息队列。
	 */
	reset() {
		this._state.messages = [];
		this._state.isStreaming = false;
		this._state.streamMessage = null;
		this._state.pendingToolCalls = new Set<string>();
		this._state.error = undefined;
		this.steeringQueue = [];
		this.followUpQueue = [];
	}

	/**
	 * 发送提示消息并启动智能体循环
	 *
	 * 支持多种调用方式：
	 * - 传入单个或多个 AgentMessage 对象
	 * - 传入字符串文本，可选附带图片内容
	 *
	 * @throws 如果智能体正在处理中，抛出错误
	 * @throws 如果未配置模型，抛出错误
	 */
	async prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
	async prompt(input: string, images?: ImageContent[]): Promise<void>;
	async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]) {
		if (this._state.isStreaming) {
			throw new Error(
				"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
			);
		}

		const model = this._state.model;
		if (!model) throw new Error("No model configured");

		let msgs: AgentMessage[];

		if (Array.isArray(input)) {
			// 直接传入 AgentMessage 数组
			msgs = input;
		} else if (typeof input === "string") {
			// 将字符串转换为用户消息，可选附带图片
			const content: Array<TextContent | ImageContent> = [{ type: "text", text: input }];
			if (images && images.length > 0) {
				content.push(...images);
			}
			msgs = [
				{
					role: "user",
					content,
					timestamp: Date.now(),
				},
			];
		} else {
			// 单个 AgentMessage 对象
			msgs = [input];
		}

		await this._runLoop(msgs);
	}

	/**
	 * 从当前上下文继续运行（用于重试和处理排队消息）
	 *
	 * 如果最后一条消息是助手消息，尝试从队列中取出干预或跟进消息继续对话。
	 * 否则直接从当前上下文继续 LLM 调用。
	 *
	 * @throws 如果智能体正在处理中，抛出错误
	 * @throws 如果没有消息可继续，抛出错误
	 * @throws 如果最后一条是助手消息且队列为空，抛出错误
	 */
	async continue() {
		if (this._state.isStreaming) {
			throw new Error("Agent is already processing. Wait for completion before continuing.");
		}

		const messages = this._state.messages;
		if (messages.length === 0) {
			throw new Error("No messages to continue from");
		}
		if (messages[messages.length - 1].role === "assistant") {
			// 最后是助手消息，尝试取出排队的干预消息
			const queuedSteering = this.dequeueSteeringMessages();
			if (queuedSteering.length > 0) {
				await this._runLoop(queuedSteering, { skipInitialSteeringPoll: true });
				return;
			}

			// 没有干预消息，尝试取出跟进消息
			const queuedFollowUp = this.dequeueFollowUpMessages();
			if (queuedFollowUp.length > 0) {
				await this._runLoop(queuedFollowUp);
				return;
			}

			throw new Error("Cannot continue from message role: assistant");
		}

		// 最后不是助手消息（如 toolResult），直接继续循环
		await this._runLoop(undefined);
	}

	/**
	 * 运行智能体循环（内部方法）
	 *
	 * 如果提供了消息，则以这些消息开始新的对话轮次。
	 * 否则从现有上下文继续运行。
	 *
	 * 负责设置和清理运行时状态（中止控制器、流式标志等），
	 * 处理事件流并更新内部状态，以及错误处理和恢复。
	 *
	 * @param messages - 可选的初始消息列表
	 * @param options - 可选的运行选项
	 */
	private async _runLoop(messages?: AgentMessage[], options?: { skipInitialSteeringPoll?: boolean }) {
		const model = this._state.model;
		if (!model) throw new Error("No model configured");

		// 创建运行中 Promise，供 waitForIdle 使用
		this.runningPrompt = new Promise<void>((resolve) => {
			this.resolveRunningPrompt = resolve;
		});

		// 初始化运行时状态
		this.abortController = new AbortController();
		this._state.isStreaming = true;
		this._state.streamMessage = null;
		this._state.error = undefined;

		// 将思考级别转换为 LLM 配置（"off" 映射为 undefined）
		const reasoning = this._state.thinkingLevel === "off" ? undefined : this._state.thinkingLevel;

		// 构建智能体上下文
		const context: AgentContext = {
			systemPrompt: this._state.systemPrompt,
			messages: this._state.messages.slice(),
			tools: this._state.tools,
		};

		let skipInitialSteeringPoll = options?.skipInitialSteeringPoll === true;

		// 构建循环配置
		const config: AgentLoopConfig = {
			model,
			reasoning,
			sessionId: this._sessionId,
			transport: this._transport,
			thinkingBudgets: this._thinkingBudgets,
			maxRetryDelayMs: this._maxRetryDelayMs,
			convertToLlm: this.convertToLlm,
			transformContext: this.transformContext,
			getApiKey: this.getApiKey,
			getSteeringMessages: async () => {
				// 首次轮询时可跳过（当干预消息已作为初始消息传入时）
				if (skipInitialSteeringPoll) {
					skipInitialSteeringPoll = false;
					return [];
				}
				return this.dequeueSteeringMessages();
			},
			getFollowUpMessages: async () => this.dequeueFollowUpMessages(),
		};

		// 跟踪当前流式传输中的部分消息
		let partial: AgentMessage | null = null;

		try {
			// 根据是否有新消息选择启动模式
			const stream = messages
				? agentLoop(messages, context, config, this.abortController.signal, this.streamFn)
				: agentLoopContinue(context, config, this.abortController.signal, this.streamFn);

			// 消费事件流并更新内部状态
			for await (const event of stream) {
				switch (event.type) {
					case "message_start":
						// 消息开始：设置流式消息引用
						partial = event.message;
						this._state.streamMessage = event.message;
						break;

					case "message_update":
						// 消息更新：刷新流式消息内容
						partial = event.message;
						this._state.streamMessage = event.message;
						break;

					case "message_end":
						// 消息完成：清除流式引用，将完整消息追加到历史
						partial = null;
						this._state.streamMessage = null;
						this.appendMessage(event.message);
						break;

					case "tool_execution_start": {
						// 工具执行开始：将工具调用 ID 添加到待处理集合
						const s = new Set(this._state.pendingToolCalls);
						s.add(event.toolCallId);
						this._state.pendingToolCalls = s;
						break;
					}

					case "tool_execution_end": {
						// 工具执行结束：从待处理集合中移除工具调用 ID
						const s = new Set(this._state.pendingToolCalls);
						s.delete(event.toolCallId);
						this._state.pendingToolCalls = s;
						break;
					}

					case "turn_end":
						// 轮次结束：检查助手消息是否包含错误
						if (event.message.role === "assistant" && (event.message as any).errorMessage) {
							this._state.error = (event.message as any).errorMessage;
						}
						break;

					case "agent_end":
						// 智能体结束：清理流式状态
						this._state.isStreaming = false;
						this._state.streamMessage = null;
						break;
				}

				// 向所有监听器发送事件
				this.emit(event);
			}

			// 处理可能残留的部分消息（流被中断时）
			if (partial && partial.role === "assistant" && partial.content.length > 0) {
				// 检查部分消息是否包含有意义的内容
				const onlyEmpty = !partial.content.some(
					(c) =>
						(c.type === "thinking" && c.thinking.trim().length > 0) ||
						(c.type === "text" && c.text.trim().length > 0) ||
						(c.type === "toolCall" && c.name.trim().length > 0),
				);
				if (!onlyEmpty) {
					// 有内容的部分消息：追加到历史
					this.appendMessage(partial);
				} else {
					// 无内容且被中止：抛出中止错误
					if (this.abortController?.signal.aborted) {
						throw new Error("Request was aborted");
					}
				}
			}
		} catch (err: any) {
			// 构建错误消息并追加到历史
			const errorMsg: AgentMessage = {
				role: "assistant",
				content: [{ type: "text", text: "" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: this.abortController?.signal.aborted ? "aborted" : "error",
				errorMessage: err?.message || String(err),
				timestamp: Date.now(),
			} as AgentMessage;

			this.appendMessage(errorMsg);
			this._state.error = err?.message || String(err);
			this.emit({ type: "agent_end", messages: [errorMsg] });
		} finally {
			// 清理运行时状态
			this._state.isStreaming = false;
			this._state.streamMessage = null;
			this._state.pendingToolCalls = new Set<string>();
			this.abortController = undefined;
			this.resolveRunningPrompt?.();
			this.runningPrompt = undefined;
			this.resolveRunningPrompt = undefined;
		}
	}

	/**
	 * 向所有已注册的监听器发送事件
	 *
	 * @param e - 要发送的智能体事件
	 */
	private emit(e: AgentEvent) {
		for (const listener of this.listeners) {
			listener(e);
		}
	}
}
