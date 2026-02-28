/**
 * RPC 客户端库，用于程序化访问编码代理。
 *
 * 该文件提供 RpcClient 类，负责：
 * - 以 RPC 模式启动代理子进程
 * - 通过 stdin/stdout 的 JSON 行协议进行通信
 * - 提供所有操作的类型安全 API 方法
 * - 支持事件订阅和异步等待机制
 *
 * 典型用法：创建 RpcClient 实例 -> start() -> prompt() -> waitForIdle() -> stop()
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as readline from "node:readline";
import type { AgentEvent, AgentMessage, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import type { SessionStats } from "../../core/agent-session.js";
import type { BashResult } from "../../core/bash-executor.js";
import type { CompactionResult } from "../../core/compaction/index.js";
import type { RpcCommand, RpcResponse, RpcSessionState, RpcSlashCommand } from "./rpc-types.js";

// ============================================================================
// 类型定义
// ============================================================================

/** 分布式 Omit，支持联合类型（标准 Omit 对联合类型不友好） */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** 不含 id 字段的 RpcCommand（内部发送时自动生成 id） */
type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;

/**
 * RPC 客户端配置选项。
 */
export interface RpcClientOptions {
	/** CLI 入口文件路径（默认搜索 dist/cli.js） */
	cliPath?: string;
	/** 代理的工作目录 */
	cwd?: string;
	/** 环境变量 */
	env?: Record<string, string>;
	/** 要使用的 AI 提供商 */
	provider?: string;
	/** 要使用的模型 ID */
	model?: string;
	/** 额外的 CLI 参数 */
	args?: string[];
}

/**
 * 模型信息接口，包含模型的基本属性。
 */
export interface ModelInfo {
	/** AI 提供商名称 */
	provider: string;
	/** 模型标识符 */
	id: string;
	/** 上下文窗口大小（token 数） */
	contextWindow: number;
	/** 是否支持推理能力 */
	reasoning: boolean;
}

/** 代理事件监听器类型 */
export type RpcEventListener = (event: AgentEvent) => void;

// ============================================================================
// RPC 客户端
// ============================================================================

/**
 * RPC 客户端类。
 * 通过子进程方式启动编码代理，提供完整的类型安全 API。
 * 使用 JSON 行协议通过 stdin/stdout 与代理进程通信。
 */
export class RpcClient {
	/** 代理子进程 */
	private process: ChildProcess | null = null;
	/** stdout 行读取器 */
	private rl: readline.Interface | null = null;
	/** 事件监听器列表 */
	private eventListeners: RpcEventListener[] = [];
	/** 待处理的请求映射：请求 ID -> Promise 回调 */
	private pendingRequests: Map<string, { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }> =
		new Map();
	/** 自增请求 ID 计数器 */
	private requestId = 0;
	/** 收集的 stderr 输出（用于调试） */
	private stderr = "";

	constructor(private options: RpcClientOptions = {}) {}

	/**
	 * 启动 RPC 代理进程。
	 * 生成子进程，建立 stdin/stdout 通信通道，并等待进程初始化。
	 */
	async start(): Promise<void> {
		if (this.process) {
			throw new Error("Client already started");
		}

		const cliPath = this.options.cliPath ?? "dist/cli.js";
		const args = ["--mode", "rpc"];

		if (this.options.provider) {
			args.push("--provider", this.options.provider);
		}
		if (this.options.model) {
			args.push("--model", this.options.model);
		}
		if (this.options.args) {
			args.push(...this.options.args);
		}

		this.process = spawn("node", [cliPath, ...args], {
			cwd: this.options.cwd,
			env: { ...process.env, ...this.options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});

		// 收集 stderr 输出用于调试
		this.process.stderr?.on("data", (data) => {
			this.stderr += data.toString();
		});

		// 设置 stdout 行读取器
		this.rl = readline.createInterface({
			input: this.process.stdout!,
			terminal: false,
		});

		this.rl.on("line", (line) => {
			this.handleLine(line);
		});

		// 等待进程初始化
		await new Promise((resolve) => setTimeout(resolve, 100));

		if (this.process.exitCode !== null) {
			throw new Error(`Agent process exited immediately with code ${this.process.exitCode}. Stderr: ${this.stderr}`);
		}
	}

	/**
	 * 停止 RPC 代理进程。
	 * 发送 SIGTERM 信号，超时后强制 SIGKILL，并清理所有资源。
	 */
	async stop(): Promise<void> {
		if (!this.process) return;

		this.rl?.close();
		this.process.kill("SIGTERM");

		// 等待进程退出，超时 1 秒后强制终止
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				this.process?.kill("SIGKILL");
				resolve();
			}, 1000);

			this.process?.on("exit", () => {
				clearTimeout(timeout);
				resolve();
			});
		});

		this.process = null;
		this.rl = null;
		this.pendingRequests.clear();
	}

	/**
	 * 订阅代理事件。
	 * @returns 取消订阅的函数
	 */
	onEvent(listener: RpcEventListener): () => void {
		this.eventListeners.push(listener);
		return () => {
			const index = this.eventListeners.indexOf(listener);
			if (index !== -1) {
				this.eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * 获取收集的 stderr 输出（用于调试）。
	 */
	getStderr(): string {
		return this.stderr;
	}

	// =========================================================================
	// 命令方法
	// =========================================================================

	/**
	 * 向代理发送提示词。
	 * 发送后立即返回；使用 onEvent() 接收流式事件，
	 * 使用 waitForIdle() 等待完成。
	 */
	async prompt(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "prompt", message, images });
	}

	/**
	 * 发送引导消息，在代理运行过程中进行中断和引导。
	 */
	async steer(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "steer", message, images });
	}

	/**
	 * 排队一条后续消息，在代理完成当前任务后处理。
	 */
	async followUp(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "follow_up", message, images });
	}

	/**
	 * 中止当前操作。
	 */
	async abort(): Promise<void> {
		await this.send({ type: "abort" });
	}

	/**
	 * 创建新会话，可选择关联父会话。
	 * @param parentSession - 可选的父会话路径，用于谱系追踪
	 * @returns 如果扩展取消了新建会话则返回 `cancelled: true`
	 */
	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "new_session", parentSession });
		return this.getData(response);
	}

	/**
	 * 获取当前会话状态快照。
	 */
	async getState(): Promise<RpcSessionState> {
		const response = await this.send({ type: "get_state" });
		return this.getData(response);
	}

	/**
	 * 按提供商和模型 ID 设置模型。
	 */
	async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
		const response = await this.send({ type: "set_model", provider, modelId });
		return this.getData(response);
	}

	/**
	 * 切换到下一个模型。
	 */
	async cycleModel(): Promise<{
		model: { provider: string; id: string };
		thinkingLevel: ThinkingLevel;
		isScoped: boolean;
	} | null> {
		const response = await this.send({ type: "cycle_model" });
		return this.getData(response);
	}

	/**
	 * 获取可用模型列表。
	 */
	async getAvailableModels(): Promise<ModelInfo[]> {
		const response = await this.send({ type: "get_available_models" });
		return this.getData<{ models: ModelInfo[] }>(response).models;
	}

	/**
	 * 设置思考级别。
	 */
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.send({ type: "set_thinking_level", level });
	}

	/**
	 * 循环切换思考级别。
	 */
	async cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null> {
		const response = await this.send({ type: "cycle_thinking_level" });
		return this.getData(response);
	}

	/**
	 * 设置引导消息处理模式。
	 */
	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_steering_mode", mode });
	}

	/**
	 * 设置后续消息处理模式。
	 */
	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_follow_up_mode", mode });
	}

	/**
	 * 压缩会话上下文。
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		const response = await this.send({ type: "compact", customInstructions });
		return this.getData(response);
	}

	/**
	 * 启用或禁用自动压缩。
	 */
	async setAutoCompaction(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_compaction", enabled });
	}

	/**
	 * 启用或禁用自动重试。
	 */
	async setAutoRetry(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_retry", enabled });
	}

	/**
	 * 中止正在进行的重试。
	 */
	async abortRetry(): Promise<void> {
		await this.send({ type: "abort_retry" });
	}

	/**
	 * 执行 Bash 命令。
	 */
	async bash(command: string): Promise<BashResult> {
		const response = await this.send({ type: "bash", command });
		return this.getData(response);
	}

	/**
	 * 中止正在运行的 Bash 命令。
	 */
	async abortBash(): Promise<void> {
		await this.send({ type: "abort_bash" });
	}

	/**
	 * 获取会话统计信息。
	 */
	async getSessionStats(): Promise<SessionStats> {
		const response = await this.send({ type: "get_session_stats" });
		return this.getData(response);
	}

	/**
	 * 导出会话为 HTML 文件。
	 */
	async exportHtml(outputPath?: string): Promise<{ path: string }> {
		const response = await this.send({ type: "export_html", outputPath });
		return this.getData(response);
	}

	/**
	 * 切换到不同的会话文件。
	 * @returns 如果扩展取消了切换则返回 `cancelled: true`
	 */
	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "switch_session", sessionPath });
		return this.getData(response);
	}

	/**
	 * 从指定消息处分叉。
	 * @returns 包含 `text`（消息文本）和 `cancelled`（是否被扩展取消）的对象
	 */
	async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		const response = await this.send({ type: "fork", entryId });
		return this.getData(response);
	}

	/**
	 * 获取可用于分叉的消息列表。
	 */
	async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
		const response = await this.send({ type: "get_fork_messages" });
		return this.getData<{ messages: Array<{ entryId: string; text: string }> }>(response).messages;
	}

	/**
	 * 获取最后一条助手消息的文本内容。
	 */
	async getLastAssistantText(): Promise<string | null> {
		const response = await this.send({ type: "get_last_assistant_text" });
		return this.getData<{ text: string | null }>(response).text;
	}

	/**
	 * 设置会话的显示名称。
	 */
	async setSessionName(name: string): Promise<void> {
		await this.send({ type: "set_session_name", name });
	}

	/**
	 * 获取会话中的所有消息。
	 */
	async getMessages(): Promise<AgentMessage[]> {
		const response = await this.send({ type: "get_messages" });
		return this.getData<{ messages: AgentMessage[] }>(response).messages;
	}

	/**
	 * 获取可用命令（扩展命令、提示词模板、技能）。
	 */
	async getCommands(): Promise<RpcSlashCommand[]> {
		const response = await this.send({ type: "get_commands" });
		return this.getData<{ commands: RpcSlashCommand[] }>(response).commands;
	}

	// =========================================================================
	// 辅助方法
	// =========================================================================

	/**
	 * 等待代理进入空闲状态（无流式输出）。
	 * 收到 agent_end 事件时 resolve。
	 *
	 * @param timeout - 超时时间（毫秒），默认 60 秒
	 */
	waitForIdle(timeout = 60000): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Timeout waiting for agent to become idle. Stderr: ${this.stderr}`));
			}, timeout);

			const unsubscribe = this.onEvent((event) => {
				if (event.type === "agent_end") {
					clearTimeout(timer);
					unsubscribe();
					resolve();
				}
			});
		});
	}

	/**
	 * 收集事件直到代理进入空闲状态。
	 * @returns 收集到的所有事件数组
	 */
	collectEvents(timeout = 60000): Promise<AgentEvent[]> {
		return new Promise((resolve, reject) => {
			const events: AgentEvent[] = [];
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Timeout collecting events. Stderr: ${this.stderr}`));
			}, timeout);

			const unsubscribe = this.onEvent((event) => {
				events.push(event);
				if (event.type === "agent_end") {
					clearTimeout(timer);
					unsubscribe();
					resolve(events);
				}
			});
		});
	}

	/**
	 * 发送提示词并等待完成，返回所有收集到的事件。
	 * 这是 prompt() + collectEvents() 的便捷组合方法。
	 */
	async promptAndWait(message: string, images?: ImageContent[], timeout = 60000): Promise<AgentEvent[]> {
		const eventsPromise = this.collectEvents(timeout);
		await this.prompt(message, images);
		return eventsPromise;
	}

	// =========================================================================
	// 内部方法
	// =========================================================================

	/**
	 * 处理从 stdout 收到的一行 JSON 数据。
	 * 区分响应消息（匹配 pending 请求）和事件消息（分发给监听器）。
	 */
	private handleLine(line: string): void {
		try {
			const data = JSON.parse(line);

			// 检查是否是对待处理请求的响应
			if (data.type === "response" && data.id && this.pendingRequests.has(data.id)) {
				const pending = this.pendingRequests.get(data.id)!;
				this.pendingRequests.delete(data.id);
				pending.resolve(data as RpcResponse);
				return;
			}

			// 否则作为事件分发给所有监听器
			for (const listener of this.eventListeners) {
				listener(data as AgentEvent);
			}
		} catch {
			// 忽略非 JSON 格式的行
		}
	}

	/**
	 * 发送 RPC 命令并等待响应。
	 * 自动生成请求 ID，设置 30 秒超时。
	 */
	private async send(command: RpcCommandBody): Promise<RpcResponse> {
		if (!this.process?.stdin) {
			throw new Error("Client not started");
		}

		const id = `req_${++this.requestId}`;
		const fullCommand = { ...command, id } as RpcCommand;

		return new Promise((resolve, reject) => {
			this.pendingRequests.set(id, { resolve, reject });

			const timeout = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Timeout waiting for response to ${command.type}. Stderr: ${this.stderr}`));
			}, 30000);

			this.pendingRequests.set(id, {
				resolve: (response) => {
					clearTimeout(timeout);
					resolve(response);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
			});

			this.process!.stdin!.write(`${JSON.stringify(fullCommand)}\n`);
		});
	}

	/**
	 * 从响应中提取数据，失败时抛出错误。
	 * 通过类型断言将响应数据转换为期望的类型 T。
	 */
	private getData<T>(response: RpcResponse): T {
		if (!response.success) {
			const errorResponse = response as Extract<RpcResponse, { success: false }>;
			throw new Error(errorResponse.error);
		}
		// Type assertion: we trust response.data matches T based on the command sent.
		// This is safe because each public method specifies the correct T for its command.
		const successResponse = response as Extract<RpcResponse, { success: true; data: unknown }>;
		return successResponse.data as T;
	}
}
