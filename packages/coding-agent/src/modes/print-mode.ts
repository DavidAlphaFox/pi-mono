/**
 * 打印模式（单次运行模式）：发送提示词，输出结果，然后退出。
 *
 * 该模式用于非交互式场景：
 * - `pi -p "prompt"` — 文本输出模式，仅输出最终的助手回复文本
 * - `pi --mode json "prompt"` — JSON 事件流模式，输出所有代理事件
 *
 * 适用于脚本调用、管道操作和 CI/CD 集成等场景。
 */

import type { AssistantMessage, ImageContent } from "@mariozechner/pi-ai";
import type { AgentSession } from "../core/agent-session.js";

/**
 * 打印模式的配置选项。
 */
export interface PrintModeOptions {
	/** 输出模式："text" 仅输出最终响应文本，"json" 输出所有事件的 JSON 流 */
	mode: "text" | "json";
	/** 在 initialMessage 之后要发送的额外提示词数组 */
	messages?: string[];
	/** 启动时发送的第一条消息（可包含 @file 引用内容） */
	initialMessage?: string;
	/** 附加到初始消息的图片内容 */
	initialImages?: ImageContent[];
}

/**
 * 以打印（单次运行）模式运行代理。
 * 向代理发送提示词，输出结果后返回。
 *
 * @param session - 代理会话实例
 * @param options - 打印模式配置选项
 */
export async function runPrintMode(session: AgentSession, options: PrintModeOptions): Promise<void> {
	const { mode, messages = [], initialMessage, initialImages } = options;
	if (mode === "json") {
		const header = session.sessionManager.getHeader();
		if (header) {
			console.log(JSON.stringify(header));
		}
	}
	// 为打印模式初始化扩展（无 UI 界面）
	await session.bindExtensions({
		commandContextActions: {
			waitForIdle: () => session.agent.waitForIdle(),
			newSession: async (options) => {
				const success = await session.newSession({ parentSession: options?.parentSession });
				if (success && options?.setup) {
					await options.setup(session.sessionManager);
				}
				return { cancelled: !success };
			},
			fork: async (entryId) => {
				const result = await session.fork(entryId);
				return { cancelled: result.cancelled };
			},
			navigateTree: async (targetId, options) => {
				const result = await session.navigateTree(targetId, {
					summarize: options?.summarize,
					customInstructions: options?.customInstructions,
					replaceInstructions: options?.replaceInstructions,
					label: options?.label,
				});
				return { cancelled: result.cancelled };
			},
			switchSession: async (sessionPath) => {
				const success = await session.switchSession(sessionPath);
				return { cancelled: !success };
			},
			reload: async () => {
				await session.reload();
			},
		},
		onError: (err) => {
			console.error(`Extension error (${err.extensionPath}): ${err.error}`);
		},
	});

	// 始终订阅事件以支持通过 _handleAgentEvent 进行会话持久化
	session.subscribe((event) => {
		// JSON 模式下输出所有事件
		if (mode === "json") {
			console.log(JSON.stringify(event));
		}
	});

	// 发送带附件的初始消息
	if (initialMessage) {
		await session.prompt(initialMessage, { images: initialImages });
	}

	// 发送剩余的消息
	for (const message of messages) {
		await session.prompt(message);
	}

	// 在文本模式下，输出最终的助手响应
	if (mode === "text") {
		const state = session.state;
		const lastMessage = state.messages[state.messages.length - 1];

		if (lastMessage?.role === "assistant") {
			const assistantMsg = lastMessage as AssistantMessage;

			// 检查是否出错或被中止
			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
				console.error(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
				process.exit(1);
			}

			// 输出文本内容
			for (const content of assistantMsg.content) {
				if (content.type === "text") {
					console.log(content.text);
				}
			}
		}
	}

	// 确保 stdout 完全刷新后再返回
	// 防止进程在所有输出写入前退出的竞争条件
	await new Promise<void>((resolve, reject) => {
		process.stdout.write("", (err) => {
			if (err) reject(err);
			else resolve();
		});
	});
}
