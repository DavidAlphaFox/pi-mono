#!/usr/bin/env node

/**
 * @file main.ts - Mom Slack 机器人主入口文件
 *
 * 本文件是 mom 机器人的启动入口，负责：
 * 1. 解析命令行参数（工作目录、沙盒配置、下载模式）
 * 2. 校验环境变量（Slack App Token 和 Bot Token）
 * 3. 管理每个频道的运行状态（ChannelState）
 * 4. 创建 Slack 上下文适配器，将 Slack 事件桥接到 Agent 运行器
 * 5. 定义消息处理器（MomHandler），处理用户消息和停止命令
 * 6. 启动 SlackBot、事件监视器，并注册进程退出信号处理
 */

import { join, resolve } from "path";
import { type AgentRunner, getOrCreateRunner } from "./agent.js";
import { downloadChannel } from "./download.js";
import { createEventsWatcher } from "./events.js";
import * as log from "./log.js";
import { parseSandboxArg, type SandboxConfig, validateSandbox } from "./sandbox.js";
import { type MomHandler, type SlackBot, SlackBot as SlackBotClass, type SlackEvent } from "./slack.js";
import { ChannelStore } from "./store.js";

// ============================================================================
// Config
// ============================================================================

/** Slack Socket Mode 应用令牌，用于 WebSocket 连接 */
const MOM_SLACK_APP_TOKEN = process.env.MOM_SLACK_APP_TOKEN;
/** Slack Bot 令牌，用于调用 Slack Web API */
const MOM_SLACK_BOT_TOKEN = process.env.MOM_SLACK_BOT_TOKEN;

/**
 * 命令行参数解析结果
 */
interface ParsedArgs {
	/** 工作目录路径 */
	workingDir?: string;
	/** 沙盒配置（host 直接运行或 docker 容器运行） */
	sandbox: SandboxConfig;
	/** 下载模式：指定要下载历史记录的频道 ID */
	downloadChannel?: string;
}

/**
 * 解析命令行参数
 * 支持的参数：
 * - --sandbox=host|docker:<name> 沙盒运行模式
 * - --download=<channel-id> 下载频道历史记录
 * - <working-directory> 工作目录（非 - 开头的参数）
 * @returns 解析后的参数对象
 */
function parseArgs(): ParsedArgs {
	const args = process.argv.slice(2);
	let sandbox: SandboxConfig = { type: "host" };
	let workingDir: string | undefined;
	let downloadChannelId: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("--sandbox=")) {
			sandbox = parseSandboxArg(arg.slice("--sandbox=".length));
		} else if (arg === "--sandbox") {
			sandbox = parseSandboxArg(args[++i] || "");
		} else if (arg.startsWith("--download=")) {
			downloadChannelId = arg.slice("--download=".length);
		} else if (arg === "--download") {
			downloadChannelId = args[++i];
		} else if (!arg.startsWith("-")) {
			// 非选项参数视为工作目录
			workingDir = arg;
		}
	}

	return {
		workingDir: workingDir ? resolve(workingDir) : undefined,
		sandbox,
		downloadChannel: downloadChannelId,
	};
}

const parsedArgs = parseArgs();

// 处理 --download 模式：下载指定频道的历史消息后退出
if (parsedArgs.downloadChannel) {
	if (!MOM_SLACK_BOT_TOKEN) {
		console.error("Missing env: MOM_SLACK_BOT_TOKEN");
		process.exit(1);
	}
	await downloadChannel(parsedArgs.downloadChannel, MOM_SLACK_BOT_TOKEN);
	process.exit(0);
}

// 正常机器人模式 - 必须指定工作目录
if (!parsedArgs.workingDir) {
	console.error("Usage: mom [--sandbox=host|docker:<name>] <working-directory>");
	console.error("       mom --download <channel-id>");
	process.exit(1);
}

const { workingDir, sandbox } = { workingDir: parsedArgs.workingDir, sandbox: parsedArgs.sandbox };

if (!MOM_SLACK_APP_TOKEN || !MOM_SLACK_BOT_TOKEN) {
	console.error("Missing env: MOM_SLACK_APP_TOKEN, MOM_SLACK_BOT_TOKEN");
	process.exit(1);
}

// 验证沙盒配置（Docker 模式下检查容器是否运行）
await validateSandbox(sandbox);

// ============================================================================
// State (per channel)
// ============================================================================

/**
 * 每个频道的运行状态
 */
interface ChannelState {
	/** 当前是否正在运行 Agent */
	running: boolean;
	/** 该频道的 Agent 运行器 */
	runner: AgentRunner;
	/** 频道消息存储 */
	store: ChannelStore;
	/** 是否已请求停止 */
	stopRequested: boolean;
	/** 停止消息的时间戳，用于后续更新该消息 */
	stopMessageTs?: string;
}

/** 所有频道的状态映射表，key 为频道 ID */
const channelStates = new Map<string, ChannelState>();

/**
 * 获取指定频道的状态，如果不存在则创建新的
 * @param channelId - Slack 频道 ID
 * @returns 该频道的运行状态
 */
function getState(channelId: string): ChannelState {
	let state = channelStates.get(channelId);
	if (!state) {
		const channelDir = join(workingDir, channelId);
		state = {
			running: false,
			runner: getOrCreateRunner(sandbox, channelId, channelDir),
			store: new ChannelStore({ workingDir, botToken: MOM_SLACK_BOT_TOKEN! }),
			stopRequested: false,
		};
		channelStates.set(channelId, state);
	}
	return state;
}

// ============================================================================
// Create SlackContext adapter
// ============================================================================

/**
 * 创建 Slack 上下文适配器
 * 将 Slack 事件和 Bot API 封装为统一的上下文对象，供 Agent 使用。
 * 内部维护消息累积、工作指示器、线程消息等状态。
 *
 * @param event - Slack 事件对象
 * @param slack - SlackBot 实例，用于发送/更新消息
 * @param state - 频道状态
 * @param isEvent - 是否为定时事件触发（影响初始状态消息文案）
 * @returns 包含 respond、replaceMessage、respondInThread 等方法的上下文对象
 */
function createSlackContext(event: SlackEvent, slack: SlackBot, state: ChannelState, isEvent?: boolean) {
	/** 主消息的时间戳，null 表示尚未发送 */
	let messageTs: string | null = null;
	/** 线程中回复消息的时间戳列表 */
	const threadMessageTs: string[] = [];
	/** 累积的文本内容（多次 respond 调用会追加） */
	let accumulatedText = "";
	/** 是否处于工作中状态 */
	let isWorking = true;
	/** 工作中指示器后缀 */
	const workingIndicator = " ...";
	/** 更新操作的 Promise 链，确保消息操作按顺序执行 */
	let updatePromise = Promise.resolve();

	const user = slack.getUser(event.user);

	// 从事件文本中提取事件文件名，用于状态消息显示
	const eventFilename = isEvent ? event.text.match(/^\[EVENT:([^:]+):/)?.[1] : undefined;

	return {
		/** 消息上下文信息 */
		message: {
			text: event.text,
			rawText: event.text,
			user: event.user,
			userName: user?.userName,
			channel: event.channel,
			ts: event.ts,
			attachments: (event.attachments || []).map((a) => ({ local: a.local })),
		},
		channelName: slack.getChannel(event.channel)?.name,
		store: state.store,
		/** 所有频道列表，供 Agent 系统提示词使用 */
		channels: slack.getAllChannels().map((c) => ({ id: c.id, name: c.name })),
		/** 所有用户列表，供 Agent 系统提示词使用 */
		users: slack.getAllUsers().map((u) => ({ id: u.id, userName: u.userName, displayName: u.displayName })),

		/**
		 * 追加文本到主消息
		 * 如果主消息不存在则创建新消息，否则更新已有消息
		 * @param text - 要追加的文本
		 * @param shouldLog - 是否记录到日志文件
		 */
		respond: async (text: string, shouldLog = true) => {
			updatePromise = updatePromise.then(async () => {
				accumulatedText = accumulatedText ? `${accumulatedText}\n${text}` : text;
				const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;

				if (messageTs) {
					await slack.updateMessage(event.channel, messageTs, displayText);
				} else {
					messageTs = await slack.postMessage(event.channel, displayText);
				}

				if (shouldLog && messageTs) {
					slack.logBotResponse(event.channel, text, messageTs);
				}
			});
			await updatePromise;
		},

		/**
		 * 替换主消息的全部内容
		 * @param text - 新的完整文本内容
		 */
		replaceMessage: async (text: string) => {
			updatePromise = updatePromise.then(async () => {
				accumulatedText = text;
				const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;
				if (messageTs) {
					await slack.updateMessage(event.channel, messageTs, displayText);
				} else {
					messageTs = await slack.postMessage(event.channel, displayText);
				}
			});
			await updatePromise;
		},

		/**
		 * 在主消息的线程中回复
		 * @param text - 线程回复的文本
		 */
		respondInThread: async (text: string) => {
			updatePromise = updatePromise.then(async () => {
				if (messageTs) {
					const ts = await slack.postInThread(event.channel, messageTs, text);
					threadMessageTs.push(ts);
				}
			});
			await updatePromise;
		},

		/**
		 * 设置输入中/思考中状态
		 * 在尚未有主消息时，发送一条初始状态消息
		 * @param isTyping - 是否正在输入
		 */
		setTyping: async (isTyping: boolean) => {
			if (isTyping && !messageTs) {
				updatePromise = updatePromise.then(async () => {
					if (!messageTs) {
						accumulatedText = eventFilename ? `_Starting event: ${eventFilename}_` : "_Thinking_";
						messageTs = await slack.postMessage(event.channel, accumulatedText + workingIndicator);
					}
				});
				await updatePromise;
			}
		},

		/**
		 * 上传文件到 Slack 频道
		 * @param filePath - 要上传的文件路径
		 * @param title - 文件标题（可选）
		 */
		uploadFile: async (filePath: string, title?: string) => {
			await slack.uploadFile(event.channel, filePath, title);
		},

		/**
		 * 设置工作中状态（控制 "..." 指示器的显示）
		 * @param working - 是否处于工作中
		 */
		setWorking: async (working: boolean) => {
			updatePromise = updatePromise.then(async () => {
				isWorking = working;
				if (messageTs) {
					const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;
					await slack.updateMessage(event.channel, messageTs, displayText);
				}
			});
			await updatePromise;
		},

		/**
		 * 删除主消息及其所有线程回复
		 * 按逆序先删除线程消息，再删除主消息
		 */
		deleteMessage: async () => {
			updatePromise = updatePromise.then(async () => {
				// 先逆序删除线程消息
				for (let i = threadMessageTs.length - 1; i >= 0; i--) {
					try {
						await slack.deleteMessage(event.channel, threadMessageTs[i]);
					} catch {
						// 忽略删除线程消息的错误
					}
				}
				threadMessageTs.length = 0;
				// 再删除主消息
				if (messageTs) {
					await slack.deleteMessage(event.channel, messageTs);
					messageTs = null;
				}
			});
			await updatePromise;
		},
	};
}

// ============================================================================
// Handler
// ============================================================================

/** 消息处理器，实现 MomHandler 接口，处理 Slack 消息和停止命令 */
const handler: MomHandler = {
	/**
	 * 检查指定频道是否正在运行
	 * @param channelId - 频道 ID
	 * @returns 是否正在运行
	 */
	isRunning(channelId: string): boolean {
		const state = channelStates.get(channelId);
		return state?.running ?? false;
	},

	/**
	 * 处理停止命令：中止当前运行的 Agent
	 * @param channelId - 频道 ID
	 * @param slack - SlackBot 实例
	 */
	async handleStop(channelId: string, slack: SlackBot): Promise<void> {
		const state = channelStates.get(channelId);
		if (state?.running) {
			state.stopRequested = true;
			state.runner.abort();
			const ts = await slack.postMessage(channelId, "_Stopping..._");
			state.stopMessageTs = ts; // 保存时间戳，后续更新为"已停止"
		} else {
			await slack.postMessage(channelId, "_Nothing running_");
		}
	},

	/**
	 * 处理 Slack 事件：创建上下文并运行 Agent
	 * @param event - Slack 事件
	 * @param slack - SlackBot 实例
	 * @param isEvent - 是否为定时事件触发
	 */
	async handleEvent(event: SlackEvent, slack: SlackBot, isEvent?: boolean): Promise<void> {
		const state = getState(event.channel);

		// 标记开始运行
		state.running = true;
		state.stopRequested = false;

		log.logInfo(`[${event.channel}] Starting run: ${event.text.substring(0, 50)}`);

		try {
			// 创建 Slack 上下文适配器
			const ctx = createSlackContext(event, slack, state, isEvent);

			// 运行 Agent
			await ctx.setTyping(true);
			await ctx.setWorking(true);
			const result = await state.runner.run(ctx as any, state.store);
			await ctx.setWorking(false);

			// 如果是用户主动停止，更新停止消息
			if (result.stopReason === "aborted" && state.stopRequested) {
				if (state.stopMessageTs) {
					await slack.updateMessage(event.channel, state.stopMessageTs, "_Stopped_");
					state.stopMessageTs = undefined;
				} else {
					await slack.postMessage(event.channel, "_Stopped_");
				}
			}
		} catch (err) {
			log.logWarning(`[${event.channel}] Run error`, err instanceof Error ? err.message : String(err));
		} finally {
			state.running = false;
		}
	},
};

// ============================================================================
// Start
// ============================================================================

log.logStartup(workingDir, sandbox.type === "host" ? "host" : `docker:${sandbox.container}`);

// 共享的存储实例，用于附件下载（各频道也在 getState 中创建独立实例）
const sharedStore = new ChannelStore({ workingDir, botToken: MOM_SLACK_BOT_TOKEN! });

// 创建 SlackBot 实例
const bot = new SlackBotClass(handler, {
	appToken: MOM_SLACK_APP_TOKEN,
	botToken: MOM_SLACK_BOT_TOKEN,
	workingDir,
	store: sharedStore,
});

// 启动事件监视器（监控 events/ 目录中的定时/即时事件文件）
const eventsWatcher = createEventsWatcher(workingDir, bot);
eventsWatcher.start();

// 注册进程退出信号处理
process.on("SIGINT", () => {
	log.logInfo("Shutting down...");
	eventsWatcher.stop();
	process.exit(0);
});

process.on("SIGTERM", () => {
	log.logInfo("Shutting down...");
	eventsWatcher.stop();
	process.exit(0);
});

// 启动 Slack Bot（连接 WebSocket，加载用户/频道，回填历史消息）
bot.start();
