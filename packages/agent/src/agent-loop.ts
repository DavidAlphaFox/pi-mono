/**
 * @file 无状态的智能体循环实现
 *
 * 本文件实现了智能体循环的核心逻辑，全程使用 AgentMessage 进行操作，
 * 仅在 LLM 调用边界处才将消息转换为 Message[]。
 *
 * 循环流程：
 * 1. 接收用户消息，构建上下文
 * 2. 调用 LLM 获取助手响应（流式传输）
 * 3. 如果响应中包含工具调用，执行工具并收集结果
 * 4. 检查干预消息（用户中断），如有则跳过剩余工具调用
 * 5. 重复步骤 2-4，直到没有更多工具调用
 * 6. 检查跟进消息，如有则继续循环
 * 7. 发出 agent_end 事件，结束循环
 *
 * 所有函数均为无状态的纯函数，状态通过参数传递。
 * 事件通过 EventStream 发出，供上层（如 Agent 类）消费。
 */

import {
	type AssistantMessage,
	type Context,
	EventStream,
	streamSimple,
	type ToolResultMessage,
	validateToolArguments,
} from "@mariozechner/pi-ai";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolResult,
	StreamFn,
} from "./types.js";

/**
 * 启动一个新的智能体循环
 *
 * 将提示消息添加到上下文中，并为每条消息发出事件通知。
 * 然后进入主循环处理 LLM 响应和工具执行。
 *
 * @param prompts - 初始提示消息列表
 * @param context - 智能体上下文（系统提示词、消息历史、工具列表）
 * @param config - 循环配置（模型、转换函数、回调等）
 * @param signal - 可选的中止信号
 * @param streamFn - 可选的自定义流式调用函数
 * @returns 智能体事件流，最终值为所有新产生的消息列表
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	(async () => {
		// 收集本次循环中所有新产生的消息
		const newMessages: AgentMessage[] = [...prompts];
		// 构建包含新消息的上下文副本
		const currentContext: AgentContext = {
			...context,
			messages: [...context.messages, ...prompts],
		};

		// 发出启动事件和第一个轮次的开始事件
		stream.push({ type: "agent_start" });
		stream.push({ type: "turn_start" });
		// 为每条提示消息发出消息生命周期事件
		for (const prompt of prompts) {
			stream.push({ type: "message_start", message: prompt });
			stream.push({ type: "message_end", message: prompt });
		}

		await runLoop(currentContext, newMessages, config, signal, stream, streamFn);
	})();

	return stream;
}

/**
 * 从现有上下文继续智能体循环（不添加新消息）
 *
 * 用于重试场景 - 上下文中已包含用户消息或工具结果。
 *
 * **重要：** 上下文中最后一条消息必须通过 `convertToLlm` 转换为
 * `user` 或 `toolResult` 消息。如果不满足此条件，LLM 提供商将拒绝请求。
 * 由于 `convertToLlm` 只在每轮调用一次，此处无法提前校验。
 *
 * @param context - 智能体上下文
 * @param config - 循环配置
 * @param signal - 可选的中止信号
 * @param streamFn - 可选的自定义流式调用函数
 * @returns 智能体事件流
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	(async () => {
		const newMessages: AgentMessage[] = [];
		const currentContext: AgentContext = { ...context };

		stream.push({ type: "agent_start" });
		stream.push({ type: "turn_start" });

		await runLoop(currentContext, newMessages, config, signal, stream, streamFn);
	})();

	return stream;
}

/**
 * 创建智能体事件流实例
 *
 * 配置事件流的终止条件和最终值提取逻辑：
 * - 当收到 agent_end 事件时，流终止
 * - 最终值为 agent_end 事件中携带的消息列表
 *
 * @returns 新的 EventStream 实例
 */
function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/**
 * 智能体循环的核心逻辑
 *
 * 由 agentLoop 和 agentLoopContinue 共享的主循环实现。
 * 包含双层循环结构：
 * - 外层循环：处理跟进消息（智能体即将停止时检查是否有后续任务）
 * - 内层循环：处理工具调用和干预消息的迭代
 *
 * @param currentContext - 当前智能体上下文（会被就地修改）
 * @param newMessages - 本次循环中新产生的消息列表（会被就地修改）
 * @param config - 循环配置
 * @param signal - 可选的中止信号
 * @param stream - 事件流，用于推送事件
 * @param streamFn - 可选的自定义流式调用函数
 */
async function runLoop(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	streamFn?: StreamFn,
): Promise<void> {
	let firstTurn = true;
	// 在循环开始时检查是否有干预消息（用户可能在等待期间输入了内容）
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// 外层循环：当有跟进消息到达时继续运行
	while (true) {
		let hasMoreToolCalls = true;
		let steeringAfterTools: AgentMessage[] | null = null;

		// 内层循环：处理工具调用和干预消息
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (!firstTurn) {
				// 非首轮时发出新的轮次开始事件
				stream.push({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// 处理待注入的消息（在下一次助手响应前注入到上下文中）
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					stream.push({ type: "message_start", message });
					stream.push({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// 流式获取助手响应
			const message = await streamAssistantResponse(currentContext, config, signal, stream, streamFn);
			newMessages.push(message);

			// 如果响应为错误或中止，终止循环
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				stream.push({ type: "turn_end", message, toolResults: [] });
				stream.push({ type: "agent_end", messages: newMessages });
				stream.end(newMessages);
				return;
			}

			// 检查助手响应中是否包含工具调用
			const toolCalls = message.content.filter((c) => c.type === "toolCall");
			hasMoreToolCalls = toolCalls.length > 0;

			const toolResults: ToolResultMessage[] = [];
			if (hasMoreToolCalls) {
				// 执行所有工具调用，同时检查干预消息
				const toolExecution = await executeToolCalls(
					currentContext.tools,
					message,
					signal,
					stream,
					config.getSteeringMessages,
				);
				toolResults.push(...toolExecution.toolResults);
				steeringAfterTools = toolExecution.steeringMessages ?? null;

				// 将工具结果添加到上下文和新消息列表
				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}

			stream.push({ type: "turn_end", message, toolResults });

			// 轮次结束后获取干预消息
			if (steeringAfterTools && steeringAfterTools.length > 0) {
				// 使用工具执行期间收集到的干预消息
				pendingMessages = steeringAfterTools;
				steeringAfterTools = null;
			} else {
				// 轮询新的干预消息
				pendingMessages = (await config.getSteeringMessages?.()) || [];
			}
		}

		// 智能体即将停止，检查是否有跟进消息
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// 将跟进消息设为待处理，继续外层循环
			pendingMessages = followUpMessages;
			continue;
		}

		// 没有更多消息，退出循环
		break;
	}

	// 发出结束事件并关闭流
	stream.push({ type: "agent_end", messages: newMessages });
	stream.end(newMessages);
}

/**
 * 流式获取 LLM 助手响应
 *
 * 这是 AgentMessage[] 被转换为 Message[] 的关键位置。
 * 转换流程：
 * 1. 可选：应用上下文变换（transformContext）
 * 2. 将 AgentMessage[] 转换为 LLM 兼容的 Message[]（convertToLlm）
 * 3. 构建 LLM 上下文并发起流式调用
 * 4. 消费流式事件，发出对应的智能体事件
 *
 * @param context - 智能体上下文
 * @param config - 循环配置
 * @param signal - 可选的中止信号
 * @param stream - 事件流
 * @param streamFn - 可选的自定义流式调用函数
 * @returns 完整的助手响应消息
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	// 步骤1：应用上下文变换（AgentMessage[] → AgentMessage[]）
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// 步骤2：转换为 LLM 兼容的消息格式（AgentMessage[] → Message[]）
	const llmMessages = await config.convertToLlm(messages);

	// 步骤3：构建 LLM 上下文
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};

	const streamFunction = streamFn || streamSimple;

	// 解析 API 密钥（对于会过期的令牌很重要）
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	// 发起 LLM 流式调用
	const response = await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		signal,
	});

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	// 消费 LLM 流式事件
	for await (const event of response) {
		switch (event.type) {
			case "start":
				// 流开始：初始化部分消息并添加到上下文
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				stream.push({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				// 内容增量更新：刷新上下文中的部分消息并发出更新事件
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					stream.push({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;

			case "done":
			case "error": {
				// 流结束或出错：获取最终消息并更新上下文
				const finalMessage = await response.result();
				if (addedPartial) {
					// 替换之前添加的部分消息
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					// 没有收到 start 事件时直接添加
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					stream.push({ type: "message_start", message: { ...finalMessage } });
				}
				stream.push({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	// 流正常结束但未收到 done/error 事件时的回退处理
	return await response.result();
}

/**
 * 执行助手消息中的工具调用
 *
 * 顺序执行每个工具调用，在每次执行后检查干预消息。
 * 如果检测到干预消息，跳过剩余的工具调用（标记为已跳过）。
 *
 * @param tools - 可用的工具列表
 * @param assistantMessage - 包含工具调用的助手消息
 * @param signal - 可选的中止信号
 * @param stream - 事件流
 * @param getSteeringMessages - 可选的干预消息获取函数
 * @returns 工具执行结果和可能的干预消息
 */
async function executeToolCalls(
	tools: AgentTool<any>[] | undefined,
	assistantMessage: AssistantMessage,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	getSteeringMessages?: AgentLoopConfig["getSteeringMessages"],
): Promise<{ toolResults: ToolResultMessage[]; steeringMessages?: AgentMessage[] }> {
	// 提取所有工具调用
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	const results: ToolResultMessage[] = [];
	let steeringMessages: AgentMessage[] | undefined;

	for (let index = 0; index < toolCalls.length; index++) {
		const toolCall = toolCalls[index];
		// 在工具列表中查找对应的工具
		const tool = tools?.find((t) => t.name === toolCall.name);

		// 发出工具执行开始事件
		stream.push({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		let result: AgentToolResult<any>;
		let isError = false;

		try {
			if (!tool) throw new Error(`Tool ${toolCall.name} not found`);

			// 校验工具参数
			const validatedArgs = validateToolArguments(tool, toolCall);

			// 执行工具，支持流式更新回调
			result = await tool.execute(toolCall.id, validatedArgs, signal, (partialResult) => {
				stream.push({
					type: "tool_execution_update",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					args: toolCall.arguments,
					partialResult,
				});
			});
		} catch (e) {
			// 工具执行失败：将错误信息作为结果
			result = {
				content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
				details: {},
			};
			isError = true;
		}

		// 发出工具执行结束事件
		stream.push({
			type: "tool_execution_end",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			result,
			isError,
		});

		// 构建工具结果消息
		const toolResultMessage: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: result.content,
			details: result.details,
			isError,
			timestamp: Date.now(),
		};

		results.push(toolResultMessage);
		stream.push({ type: "message_start", message: toolResultMessage });
		stream.push({ type: "message_end", message: toolResultMessage });

		// 检查干预消息 - 如果用户中断，跳过剩余的工具调用
		if (getSteeringMessages) {
			const steering = await getSteeringMessages();
			if (steering.length > 0) {
				steeringMessages = steering;
				// 将剩余未执行的工具调用标记为已跳过
				const remainingCalls = toolCalls.slice(index + 1);
				for (const skipped of remainingCalls) {
					results.push(skipToolCall(skipped, stream));
				}
				break;
			}
		}
	}

	return { toolResults: results, steeringMessages };
}

/**
 * 跳过一个工具调用
 *
 * 当用户干预导致需要跳过剩余工具调用时，为被跳过的工具调用
 * 生成一个错误结果消息，并发出相应的生命周期事件。
 *
 * @param toolCall - 被跳过的工具调用
 * @param stream - 事件流
 * @returns 表示已跳过的工具结果消息
 */
function skipToolCall(
	toolCall: Extract<AssistantMessage["content"][number], { type: "toolCall" }>,
	stream: EventStream<AgentEvent, AgentMessage[]>,
): ToolResultMessage {
	const result: AgentToolResult<any> = {
		content: [{ type: "text", text: "Skipped due to queued user message." }],
		details: {},
	};

	// 发出工具执行开始和结束事件（标记为错误）
	stream.push({
		type: "tool_execution_start",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		args: toolCall.arguments,
	});
	stream.push({
		type: "tool_execution_end",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		result,
		isError: true,
	});

	// 构建跳过的工具结果消息
	const toolResultMessage: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: result.content,
		details: {},
		isError: true,
		timestamp: Date.now(),
	};

	stream.push({ type: "message_start", message: toolResultMessage });
	stream.push({ type: "message_end", message: toolResultMessage });

	return toolResultMessage;
}
