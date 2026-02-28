/**
 * @file 代理流式调用函数
 *
 * 本文件实现了通过中间代理服务器转发 LLM 请求的流式函数。
 * 服务器负责管理认证并将请求代理到 LLM 提供商。
 *
 * 代理协议设计：
 * - 使用 SSE（Server-Sent Events）格式传输流式数据
 * - 服务器端剥离 delta 事件中的 partial 字段以减少带宽消耗
 * - 客户端根据接收到的事件重建完整的部分消息
 *
 * 使用方式：
 * 将 streamProxy 作为 Agent 的 streamFn 选项传入，
 * 即可让所有 LLM 调用通过代理服务器进行。
 */

// 导入 JSON 流式解析工具和相关类型
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	EventStream,
	type Model,
	parseStreamingJson,
	type SimpleStreamOptions,
	type StopReason,
	type ToolCall,
} from "@mariozechner/pi-ai";

/**
 * 代理消息事件流
 *
 * 继承自 EventStream，专门用于处理代理服务器返回的助手消息事件。
 * 当收到 done 或 error 事件时终止流。
 */
class ProxyMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

/**
 * 代理事件类型
 *
 * 服务器端发送的事件格式，相比标准的 AssistantMessageEvent，
 * 剥离了 partial 字段以减少网络带宽消耗。
 * 客户端需要根据这些事件在本地重建 partial 消息。
 */
export type ProxyAssistantMessageEvent =
	| { type: "start" }
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; contentSignature?: string }
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| { type: "thinking_end"; contentIndex: number; contentSignature?: string }
	| { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_end"; contentIndex: number }
	| {
			type: "done";
			reason: Extract<StopReason, "stop" | "length" | "toolUse">;
			usage: AssistantMessage["usage"];
	  }
	| {
			type: "error";
			reason: Extract<StopReason, "aborted" | "error">;
			errorMessage?: string;
			usage: AssistantMessage["usage"];
	  };

/**
 * 代理流式调用选项
 *
 * 继承自 SimpleStreamOptions，额外要求提供代理服务器的
 * 认证令牌和服务器地址。
 */
export interface ProxyStreamOptions extends SimpleStreamOptions {
	/** 代理服务器的认证令牌 */
	authToken: string;
	/** 代理服务器 URL（例如 "https://genai.example.com"） */
	proxyUrl: string;
}

/**
 * 代理流式调用函数
 *
 * 通过代理服务器而非直接调用 LLM 提供商进行流式调用。
 * 服务器剥离 delta 事件中的 partial 字段以减少带宽，
 * 客户端在本地重建完整的部分消息。
 *
 * 用作创建 Agent 时的 `streamFn` 选项。
 *
 * @example
 * ```typescript
 * const agent = new Agent({
 *   streamFn: (model, context, options) =>
 *     streamProxy(model, context, {
 *       ...options,
 *       authToken: await getAuthToken(),
 *       proxyUrl: "https://genai.example.com",
 *     }),
 * });
 * ```
 *
 * @param model - LLM 模型配置
 * @param context - LLM 上下文（系统提示词、消息、工具）
 * @param options - 代理流式调用选项（包含认证和服务器地址）
 * @returns 代理消息事件流
 */
export function streamProxy(model: Model<any>, context: Context, options: ProxyStreamOptions): ProxyMessageEventStream {
	const stream = new ProxyMessageEventStream();

	(async () => {
		// 初始化部分消息，后续会根据事件逐步填充
		const partial: AssistantMessage = {
			role: "assistant",
			stopReason: "stop",
			content: [],
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
			timestamp: Date.now(),
		};

		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

		// 中止处理器：当信号触发时取消读取器
		const abortHandler = () => {
			if (reader) {
				reader.cancel("Request aborted by user").catch(() => {});
			}
		};

		if (options.signal) {
			options.signal.addEventListener("abort", abortHandler);
		}

		try {
			// 向代理服务器发送 POST 请求
			const response = await fetch(`${options.proxyUrl}/api/stream`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${options.authToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model,
					context,
					options: {
						temperature: options.temperature,
						maxTokens: options.maxTokens,
						reasoning: options.reasoning,
					},
				}),
				signal: options.signal,
			});

			// 处理 HTTP 错误响应
			if (!response.ok) {
				let errorMessage = `Proxy error: ${response.status} ${response.statusText}`;
				try {
					const errorData = (await response.json()) as { error?: string };
					if (errorData.error) {
						errorMessage = `Proxy error: ${errorData.error}`;
					}
				} catch {
					// 无法解析错误响应体
				}
				throw new Error(errorMessage);
			}

			// 开始读取 SSE 响应流
			reader = response.body!.getReader();
			const decoder = new TextDecoder();
			let buffer = "";

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				// 检查是否已被中止
				if (options.signal?.aborted) {
					throw new Error("Request aborted by user");
				}

				// 将字节流解码并按行分割处理
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				// 最后一行可能不完整，保留到下次处理
				buffer = lines.pop() || "";

				// 解析 SSE 格式的事件数据
				for (const line of lines) {
					if (line.startsWith("data: ")) {
						const data = line.slice(6).trim();
						if (data) {
							const proxyEvent = JSON.parse(data) as ProxyAssistantMessageEvent;
							// 处理代理事件并重建部分消息
							const event = processProxyEvent(proxyEvent, partial);
							if (event) {
								stream.push(event);
							}
						}
					}
				}
			}

			// 流读取完成后再次检查中止状态
			if (options.signal?.aborted) {
				throw new Error("Request aborted by user");
			}

			stream.end();
		} catch (error) {
			// 错误处理：构建错误事件并关闭流
			const errorMessage = error instanceof Error ? error.message : String(error);
			const reason = options.signal?.aborted ? "aborted" : "error";
			partial.stopReason = reason;
			partial.errorMessage = errorMessage;
			stream.push({
				type: "error",
				reason,
				error: partial,
			});
			stream.end();
		} finally {
			// 清理中止监听器
			if (options.signal) {
				options.signal.removeEventListener("abort", abortHandler);
			}
		}
	})();

	return stream;
}

/**
 * 处理代理事件并更新部分消息
 *
 * 将代理服务器发送的精简事件转换为标准的 AssistantMessageEvent，
 * 同时在本地重建完整的 partial 消息。
 *
 * 处理逻辑按内容类型分类：
 * - text_*: 文本内容的开始、增量更新和结束
 * - thinking_*: 思考/推理内容的开始、增量更新和结束
 * - toolcall_*: 工具调用的开始、JSON 参数增量和结束
 * - done/error: 流的正常结束或错误终止
 *
 * @param proxyEvent - 代理服务器发送的事件
 * @param partial - 正在构建的部分消息（会被就地修改）
 * @returns 转换后的标准助手消息事件，如果事件无法处理则返回 undefined
 */
function processProxyEvent(
	proxyEvent: ProxyAssistantMessageEvent,
	partial: AssistantMessage,
): AssistantMessageEvent | undefined {
	switch (proxyEvent.type) {
		case "start":
			return { type: "start", partial };

		case "text_start":
			// 在指定位置初始化空文本内容块
			partial.content[proxyEvent.contentIndex] = { type: "text", text: "" };
			return { type: "text_start", contentIndex: proxyEvent.contentIndex, partial };

		case "text_delta": {
			// 追加文本增量
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "text") {
				content.text += proxyEvent.delta;
				return {
					type: "text_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received text_delta for non-text content");
		}

		case "text_end": {
			// 设置文本签名（用于内容验证）
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "text") {
				content.textSignature = proxyEvent.contentSignature;
				return {
					type: "text_end",
					contentIndex: proxyEvent.contentIndex,
					content: content.text,
					partial,
				};
			}
			throw new Error("Received text_end for non-text content");
		}

		case "thinking_start":
			// 在指定位置初始化空思考内容块
			partial.content[proxyEvent.contentIndex] = { type: "thinking", thinking: "" };
			return { type: "thinking_start", contentIndex: proxyEvent.contentIndex, partial };

		case "thinking_delta": {
			// 追加思考内容增量
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "thinking") {
				content.thinking += proxyEvent.delta;
				return {
					type: "thinking_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received thinking_delta for non-thinking content");
		}

		case "thinking_end": {
			// 设置思考签名（用于内容验证）
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "thinking") {
				content.thinkingSignature = proxyEvent.contentSignature;
				return {
					type: "thinking_end",
					contentIndex: proxyEvent.contentIndex,
					content: content.thinking,
					partial,
				};
			}
			throw new Error("Received thinking_end for non-thinking content");
		}

		case "toolcall_start":
			// 初始化工具调用内容块，包含 partialJson 用于流式 JSON 解析
			partial.content[proxyEvent.contentIndex] = {
				type: "toolCall",
				id: proxyEvent.id,
				name: proxyEvent.toolName,
				arguments: {},
				partialJson: "",
			} satisfies ToolCall & { partialJson: string } as ToolCall;
			return { type: "toolcall_start", contentIndex: proxyEvent.contentIndex, partial };

		case "toolcall_delta": {
			// 追加 JSON 参数增量并尝试流式解析
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "toolCall") {
				(content as any).partialJson += proxyEvent.delta;
				// 使用流式 JSON 解析器尝试从不完整的 JSON 中提取参数
				content.arguments = parseStreamingJson((content as any).partialJson) || {};
				// 创建新对象以触发响应式更新
				partial.content[proxyEvent.contentIndex] = { ...content };
				return {
					type: "toolcall_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received toolcall_delta for non-toolCall content");
		}

		case "toolcall_end": {
			// 清理临时的 partialJson 字段
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "toolCall") {
				delete (content as any).partialJson;
				return {
					type: "toolcall_end",
					contentIndex: proxyEvent.contentIndex,
					toolCall: content,
					partial,
				};
			}
			return undefined;
		}

		case "done":
			// 正常结束：更新停止原因和用量统计
			partial.stopReason = proxyEvent.reason;
			partial.usage = proxyEvent.usage;
			return { type: "done", reason: proxyEvent.reason, message: partial };

		case "error":
			// 错误结束：更新停止原因、错误信息和用量统计
			partial.stopReason = proxyEvent.reason;
			partial.errorMessage = proxyEvent.errorMessage;
			partial.usage = proxyEvent.usage;
			return { type: "error", reason: proxyEvent.reason, error: partial };

		default: {
			// 穷举检查：确保所有事件类型都已处理
			const _exhaustiveCheck: never = proxyEvent;
			console.warn(`Unhandled proxy event type: ${(proxyEvent as any).type}`);
			return undefined;
		}
	}
}
