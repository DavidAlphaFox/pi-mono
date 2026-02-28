/**
 * @file slack.ts - Slack 集成模块
 *
 * 本文件负责：
 * 1. 定义 Slack 相关类型（事件、用户、频道、上下文等）
 * 2. 实现 SlackBot 类，管理 Slack WebSocket 连接和 Web API 调用
 * 3. 处理 @mention 和 DM 消息事件
 * 4. 管理每个频道的消息处理队列（顺序执行）
 * 5. 启动时回填缺失的历史消息到 log.jsonl
 * 6. 加载和缓存 Slack 用户和频道信息
 */

import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { basename, join } from "path";
import * as log from "./log.js";
import type { Attachment, ChannelStore } from "./store.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Slack 事件结构
 * 表示一条来自 Slack 的 @mention 或 DM 消息
 */
export interface SlackEvent {
	/** 事件类型：频道 @mention 或私聊 DM */
	type: "mention" | "dm";
	/** 频道 ID */
	channel: string;
	/** 消息时间戳（Slack 格式，如 "1234567890.123456"） */
	ts: string;
	/** 发送者用户 ID */
	user: string;
	/** 消息文本内容 */
	text: string;
	/** 消息中的文件列表（原始 Slack 数据） */
	files?: Array<{ name?: string; url_private_download?: string; url_private?: string }>;
	/** 已处理的附件列表，包含本地路径（在 logUserMessage 之后填充） */
	attachments?: Attachment[];
}

/**
 * Slack 用户信息
 */
export interface SlackUser {
	/** 用户 ID */
	id: string;
	/** 用户名（handle） */
	userName: string;
	/** 显示名称 */
	displayName: string;
}

/**
 * Slack 频道信息
 */
export interface SlackChannel {
	/** 频道 ID */
	id: string;
	/** 频道名称 */
	name: string;
}

/**
 * 频道信息（供 agent.ts 使用的简化版本）
 */
export interface ChannelInfo {
	/** 频道 ID */
	id: string;
	/** 频道名称 */
	name: string;
}

/**
 * 用户信息（供 agent.ts 使用的简化版本）
 */
export interface UserInfo {
	/** 用户 ID */
	id: string;
	/** 用户名（handle） */
	userName: string;
	/** 显示名称 */
	displayName: string;
}

/**
 * Slack 上下文接口
 * 封装了 Agent 与 Slack 交互所需的所有方法和数据
 */
export interface SlackContext {
	/** 触发 Agent 的原始消息信息 */
	message: {
		text: string;
		rawText: string;
		user: string;
		userName?: string;
		channel: string;
		ts: string;
		attachments: Array<{ local: string }>;
	};
	/** 频道名称 */
	channelName?: string;
	/** 所有频道列表 */
	channels: ChannelInfo[];
	/** 所有用户列表 */
	users: UserInfo[];
	/** 追加文本到主消息 */
	respond: (text: string, shouldLog?: boolean) => Promise<void>;
	/** 替换主消息内容 */
	replaceMessage: (text: string) => Promise<void>;
	/** 在主消息线程中回复 */
	respondInThread: (text: string) => Promise<void>;
	/** 设置输入中状态 */
	setTyping: (isTyping: boolean) => Promise<void>;
	/** 上传文件到频道 */
	uploadFile: (filePath: string, title?: string) => Promise<void>;
	/** 设置工作中状态（控制 "..." 指示器） */
	setWorking: (working: boolean) => Promise<void>;
	/** 删除主消息及其线程回复 */
	deleteMessage: () => Promise<void>;
}

/**
 * Mom 消息处理器接口
 * 由 main.ts 实现，定义了处理 Slack 消息和停止命令的方法
 */
export interface MomHandler {
	/**
	 * 检查频道是否正在运行（同步方法）
	 */
	isRunning(channelId: string): boolean;

	/**
	 * 处理触发 mom 的事件（异步方法）
	 * 用户消息仅在 isRunning() 返回 false 时调用。
	 * 事件始终入队并传递 isEvent=true。
	 */
	handleEvent(event: SlackEvent, slack: SlackBot, isEvent?: boolean): Promise<void>;

	/**
	 * 处理停止命令（异步方法）
	 * 在 mom 正在运行时用户发送 "stop" 时调用
	 */
	handleStop(channelId: string, slack: SlackBot): Promise<void>;
}

// ============================================================================
// Per-channel queue for sequential processing
// ============================================================================

/** 队列中的工作单元类型 */
type QueuedWork = () => Promise<void>;

/**
 * 频道消息处理队列
 * 确保同一频道的消息按顺序处理，不会并发执行
 */
class ChannelQueue {
	/** 待处理的工作队列 */
	private queue: QueuedWork[] = [];
	/** 是否正在处理中 */
	private processing = false;

	/**
	 * 将工作入队
	 * @param work - 异步工作函数
	 */
	enqueue(work: QueuedWork): void {
		this.queue.push(work);
		this.processNext();
	}

	/**
	 * 获取队列中待处理的工作数量
	 * @returns 队列长度
	 */
	size(): number {
		return this.queue.length;
	}

	/**
	 * 处理队列中的下一个工作
	 * 递归调用自身直到队列为空
	 */
	private async processNext(): Promise<void> {
		if (this.processing || this.queue.length === 0) return;
		this.processing = true;
		const work = this.queue.shift()!;
		try {
			await work();
		} catch (err) {
			log.logWarning("Queue error", err instanceof Error ? err.message : String(err));
		}
		this.processing = false;
		this.processNext();
	}
}

// ============================================================================
// SlackBot
// ============================================================================

/**
 * Slack 机器人类
 * 管理与 Slack 的 WebSocket 和 Web API 连接，处理消息事件，
 * 维护用户/频道缓存，提供消息发送/更新/删除等操作
 */
export class SlackBot {
	/** Slack Socket Mode 客户端（WebSocket 连接） */
	private socketClient: SocketModeClient;
	/** Slack Web API 客户端 */
	private webClient: WebClient;
	/** 消息处理器 */
	private handler: MomHandler;
	/** 工作目录路径 */
	private workingDir: string;
	/** 频道消息存储 */
	private store: ChannelStore;
	/** 机器人自身的 Slack 用户 ID */
	private botUserId: string | null = null;
	/** 启动时间戳，早于此时间的消息仅记录不处理 */
	private startupTs: string | null = null;

	/** 用户缓存（ID -> 用户信息） */
	private users = new Map<string, SlackUser>();
	/** 频道缓存（ID -> 频道信息） */
	private channels = new Map<string, SlackChannel>();
	/** 每个频道的消息处理队列 */
	private queues = new Map<string, ChannelQueue>();

	/**
	 * 构造函数
	 * @param handler - 消息处理器
	 * @param config - 配置项（App Token、Bot Token、工作目录、存储）
	 */
	constructor(
		handler: MomHandler,
		config: { appToken: string; botToken: string; workingDir: string; store: ChannelStore },
	) {
		this.handler = handler;
		this.workingDir = config.workingDir;
		this.store = config.store;
		this.socketClient = new SocketModeClient({ appToken: config.appToken });
		this.webClient = new WebClient(config.botToken);
	}

	// ==========================================================================
	// Public API
	// ==========================================================================

	/**
	 * 启动 Slack Bot
	 * 依次执行：认证获取 Bot ID、加载用户和频道、回填历史消息、注册事件处理器、启动 WebSocket 连接
	 */
	async start(): Promise<void> {
		const auth = await this.webClient.auth.test();
		this.botUserId = auth.user_id as string;

		await Promise.all([this.fetchUsers(), this.fetchChannels()]);
		log.logInfo(`Loaded ${this.channels.size} channels, ${this.users.size} users`);

		await this.backfillAllChannels();

		this.setupEventHandlers();
		await this.socketClient.start();

		// 记录启动时间 - 早于此时间的消息仅记录不触发处理
		this.startupTs = (Date.now() / 1000).toFixed(6);

		log.logConnected();
	}

	/**
	 * 根据用户 ID 获取用户信息
	 * @param userId - Slack 用户 ID
	 * @returns 用户信息，未找到返回 undefined
	 */
	getUser(userId: string): SlackUser | undefined {
		return this.users.get(userId);
	}

	/**
	 * 根据频道 ID 获取频道信息
	 * @param channelId - Slack 频道 ID
	 * @returns 频道信息，未找到返回 undefined
	 */
	getChannel(channelId: string): SlackChannel | undefined {
		return this.channels.get(channelId);
	}

	/**
	 * 获取所有用户列表
	 * @returns 用户信息数组
	 */
	getAllUsers(): SlackUser[] {
		return Array.from(this.users.values());
	}

	/**
	 * 获取所有频道列表
	 * @returns 频道信息数组
	 */
	getAllChannels(): SlackChannel[] {
		return Array.from(this.channels.values());
	}

	/**
	 * 在频道中发送新消息
	 * @param channel - 频道 ID
	 * @param text - 消息文本
	 * @returns 消息的时间戳
	 */
	async postMessage(channel: string, text: string): Promise<string> {
		const result = await this.webClient.chat.postMessage({ channel, text });
		return result.ts as string;
	}

	/**
	 * 更新已有消息
	 * @param channel - 频道 ID
	 * @param ts - 要更新的消息时间戳
	 * @param text - 新的消息文本
	 */
	async updateMessage(channel: string, ts: string, text: string): Promise<void> {
		await this.webClient.chat.update({ channel, ts, text });
	}

	/**
	 * 删除消息
	 * @param channel - 频道 ID
	 * @param ts - 要删除的消息时间戳
	 */
	async deleteMessage(channel: string, ts: string): Promise<void> {
		await this.webClient.chat.delete({ channel, ts });
	}

	/**
	 * 在消息线程中回复
	 * @param channel - 频道 ID
	 * @param threadTs - 父消息的时间戳
	 * @param text - 回复文本
	 * @returns 回复消息的时间戳
	 */
	async postInThread(channel: string, threadTs: string, text: string): Promise<string> {
		const result = await this.webClient.chat.postMessage({ channel, thread_ts: threadTs, text });
		return result.ts as string;
	}

	/**
	 * 上传文件到频道
	 * @param channel - 频道 ID
	 * @param filePath - 要上传的文件路径
	 * @param title - 文件标题（可选，默认使用文件名）
	 */
	async uploadFile(channel: string, filePath: string, title?: string): Promise<void> {
		const fileName = title || basename(filePath);
		const fileContent = readFileSync(filePath);
		await this.webClient.files.uploadV2({
			channel_id: channel,
			file: fileContent,
			filename: fileName,
			title: fileName,
		});
	}

	/**
	 * 将消息记录到 log.jsonl（同步方法）
	 * 这是消息写入 log.jsonl 的唯一入口
	 * @param channel - 频道 ID
	 * @param entry - 日志条目对象
	 */
	logToFile(channel: string, entry: object): void {
		const dir = join(this.workingDir, channel);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	/**
	 * 将机器人响应记录到 log.jsonl
	 * @param channel - 频道 ID
	 * @param text - 响应文本
	 * @param ts - 消息时间戳
	 */
	logBotResponse(channel: string, text: string, ts: string): void {
		this.logToFile(channel, {
			date: new Date().toISOString(),
			ts,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
		});
	}

	// ==========================================================================
	// Events Integration
	// ==========================================================================

	/**
	 * 将事件入队处理
	 * 始终入队（不会因为"正在忙"而拒绝），用于定时事件触发
	 * @param event - Slack 事件
	 * @returns 是否成功入队，队列满（最多 5 个）时返回 false
	 */
	enqueueEvent(event: SlackEvent): boolean {
		const queue = this.getQueue(event.channel);
		if (queue.size() >= 5) {
			log.logWarning(`Event queue full for ${event.channel}, discarding: ${event.text.substring(0, 50)}`);
			return false;
		}
		log.logInfo(`Enqueueing event for ${event.channel}: ${event.text.substring(0, 50)}`);
		queue.enqueue(() => this.handler.handleEvent(event, this, true));
		return true;
	}

	// ==========================================================================
	// Private - Event Handlers
	// ==========================================================================

	/**
	 * 获取频道的消息处理队列，如果不存在则创建
	 * @param channelId - 频道 ID
	 * @returns 频道队列实例
	 */
	private getQueue(channelId: string): ChannelQueue {
		let queue = this.queues.get(channelId);
		if (!queue) {
			queue = new ChannelQueue();
			this.queues.set(channelId, queue);
		}
		return queue;
	}

	/**
	 * 注册 Slack 事件处理器
	 * 处理两种事件：
	 * 1. app_mention - 频道中 @mention 机器人
	 * 2. message - 所有消息（用于记录历史和处理 DM）
	 */
	private setupEventHandlers(): void {
		// 频道 @mention 事件处理
		this.socketClient.on("app_mention", ({ event, ack }) => {
			const e = event as {
				text: string;
				channel: string;
				user: string;
				ts: string;
				files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
			};

			// 跳过 DM（由 message 事件处理）
			if (e.channel.startsWith("D")) {
				ack();
				return;
			}

			const slackEvent: SlackEvent = {
				type: "mention",
				channel: e.channel,
				ts: e.ts,
				user: e.user,
				// 移除消息中的 @mention 标签
				text: e.text.replace(/<@[A-Z0-9]+>/gi, "").trim(),
				files: e.files,
			};

			// 同步：记录到 log.jsonl（始终执行，包括旧消息）
			// 同时在后台下载附件并存储本地路径
			slackEvent.attachments = this.logUserMessage(slackEvent);

			// 仅对启动后的消息触发处理（忽略回放的旧消息）
			if (this.startupTs && e.ts < this.startupTs) {
				log.logInfo(
					`[${e.channel}] Logged old message (pre-startup), not triggering: ${slackEvent.text.substring(0, 30)}`,
				);
				ack();
				return;
			}

			// 检查停止命令 - 立即执行，不入队！
			if (slackEvent.text.toLowerCase().trim() === "stop") {
				if (this.handler.isRunning(e.channel)) {
					this.handler.handleStop(e.channel, this); // 不等待，不入队
				} else {
					this.postMessage(e.channel, "_Nothing running_");
				}
				ack();
				return;
			}

			// 同步检查：是否正忙
			if (this.handler.isRunning(e.channel)) {
				this.postMessage(e.channel, "_Already working. Say `@mom stop` to cancel._");
			} else {
				this.getQueue(e.channel).enqueue(() => this.handler.handleEvent(slackEvent, this));
			}

			ack();
		});

		// 所有消息事件处理（用于记录频道聊天 + 处理 DM）
		this.socketClient.on("message", ({ event, ack }) => {
			const e = event as {
				text?: string;
				channel: string;
				user?: string;
				ts: string;
				channel_type?: string;
				subtype?: string;
				bot_id?: string;
				files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
			};

			// 跳过机器人消息、编辑等
			if (e.bot_id || !e.user || e.user === this.botUserId) {
				ack();
				return;
			}
			// 只处理普通消息和文件分享
			if (e.subtype !== undefined && e.subtype !== "file_share") {
				ack();
				return;
			}
			// 跳过没有文本和文件的空消息
			if (!e.text && (!e.files || e.files.length === 0)) {
				ack();
				return;
			}

			const isDM = e.channel_type === "im";
			const isBotMention = e.text?.includes(`<@${this.botUserId}>`);

			// 跳过频道中的 @mention - 已由 app_mention 事件处理
			if (!isDM && isBotMention) {
				ack();
				return;
			}

			const slackEvent: SlackEvent = {
				type: isDM ? "dm" : "mention",
				channel: e.channel,
				ts: e.ts,
				user: e.user,
				text: (e.text || "").replace(/<@[A-Z0-9]+>/gi, "").trim(),
				files: e.files,
			};

			// 同步：记录到 log.jsonl（所有消息，包括频道闲聊和 DM）
			// 同时在后台下载附件并存储本地路径
			slackEvent.attachments = this.logUserMessage(slackEvent);

			// 仅对启动后的消息触发处理（忽略回放的旧消息）
			if (this.startupTs && e.ts < this.startupTs) {
				log.logInfo(`[${e.channel}] Skipping old message (pre-startup): ${slackEvent.text.substring(0, 30)}`);
				ack();
				return;
			}

			// 仅对 DM 消息触发处理器
			if (isDM) {
				// 检查停止命令 - 立即执行，不入队！
				if (slackEvent.text.toLowerCase().trim() === "stop") {
					if (this.handler.isRunning(e.channel)) {
						this.handler.handleStop(e.channel, this); // 不等待，不入队
					} else {
						this.postMessage(e.channel, "_Nothing running_");
					}
					ack();
					return;
				}

				if (this.handler.isRunning(e.channel)) {
					this.postMessage(e.channel, "_Already working. Say `stop` to cancel._");
				} else {
					this.getQueue(e.channel).enqueue(() => this.handler.handleEvent(slackEvent, this));
				}
			}

			ack();
		});
	}

	/**
	 * 将用户消息记录到 log.jsonl（同步方法）
	 * 附件在后台通过 store 下载
	 * @param event - Slack 事件
	 * @returns 处理后的附件列表
	 */
	private logUserMessage(event: SlackEvent): Attachment[] {
		const user = this.users.get(event.user);
		// 处理附件 - 在后台排队下载
		const attachments = event.files ? this.store.processAttachments(event.channel, event.files, event.ts) : [];
		this.logToFile(event.channel, {
			date: new Date(parseFloat(event.ts) * 1000).toISOString(),
			ts: event.ts,
			user: event.user,
			userName: user?.userName,
			displayName: user?.displayName,
			text: event.text,
			attachments,
			isBot: false,
		});
		return attachments;
	}

	// ==========================================================================
	// Private - Backfill
	// ==========================================================================

	/**
	 * 获取频道 log.jsonl 中已有的消息时间戳集合
	 * 用于回填时去重
	 * @param channelId - 频道 ID
	 * @returns 时间戳集合
	 */
	private getExistingTimestamps(channelId: string): Set<string> {
		const logPath = join(this.workingDir, channelId, "log.jsonl");
		const timestamps = new Set<string>();
		if (!existsSync(logPath)) return timestamps;

		const content = readFileSync(logPath, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.ts) timestamps.add(entry.ts);
			} catch {}
		}
		return timestamps;
	}

	/**
	 * 回填单个频道的历史消息
	 * 从 Slack API 拉取新于 log.jsonl 中最新消息的历史记录，最多拉取 3 页
	 * @param channelId - 频道 ID
	 * @returns 新回填的消息数量
	 */
	private async backfillChannel(channelId: string): Promise<number> {
		const existingTs = this.getExistingTimestamps(channelId);

		// 找到 log.jsonl 中最新的时间戳
		let latestTs: string | undefined;
		for (const ts of existingTs) {
			if (!latestTs || parseFloat(ts) > parseFloat(latestTs)) latestTs = ts;
		}

		type Message = {
			user?: string;
			bot_id?: string;
			text?: string;
			ts?: string;
			subtype?: string;
			files?: Array<{ name: string }>;
		};
		const allMessages: Message[] = [];

		let cursor: string | undefined;
		let pageCount = 0;
		const maxPages = 3;

		// 分页拉取历史消息
		do {
			const result = await this.webClient.conversations.history({
				channel: channelId,
				oldest: latestTs, // 仅拉取新于已有记录的消息
				inclusive: false,
				limit: 1000,
				cursor,
			});
			if (result.messages) {
				allMessages.push(...(result.messages as Message[]));
			}
			cursor = result.response_metadata?.next_cursor;
			pageCount++;
		} while (cursor && pageCount < maxPages);

		// 过滤：包含 mom 自身的消息，排除其他机器人，跳过已记录的消息
		const relevantMessages = allMessages.filter((msg) => {
			if (!msg.ts || existingTs.has(msg.ts)) return false; // 跳过重复
			if (msg.user === this.botUserId) return true; // 保留 mom 的消息
			if (msg.bot_id) return false; // 排除其他机器人
			if (msg.subtype !== undefined && msg.subtype !== "file_share") return false;
			if (!msg.user) return false;
			if (!msg.text && (!msg.files || msg.files.length === 0)) return false;
			return true;
		});

		// 反转为时间顺序
		relevantMessages.reverse();

		// 将每条消息记录到 log.jsonl
		for (const msg of relevantMessages) {
			const isMomMessage = msg.user === this.botUserId;
			const user = this.users.get(msg.user!);
			// 移除 @mention 标签（与实时消息处理一致）
			const text = (msg.text || "").replace(/<@[A-Z0-9]+>/gi, "").trim();
			// 处理附件 - 在后台排队下载
			const attachments = msg.files ? this.store.processAttachments(channelId, msg.files, msg.ts!) : [];

			this.logToFile(channelId, {
				date: new Date(parseFloat(msg.ts!) * 1000).toISOString(),
				ts: msg.ts!,
				user: isMomMessage ? "bot" : msg.user!,
				userName: isMomMessage ? undefined : user?.userName,
				displayName: isMomMessage ? undefined : user?.displayName,
				text,
				attachments,
				isBot: isMomMessage,
			});
		}

		return relevantMessages.length;
	}

	/**
	 * 回填所有有交互记录的频道
	 * 仅回填已有 log.jsonl 的频道（表示 mom 之前曾在该频道中活动过）
	 */
	private async backfillAllChannels(): Promise<void> {
		const startTime = Date.now();

		// 仅回填已有 log.jsonl 的频道（mom 之前曾在该频道中交互过）
		const channelsToBackfill: Array<[string, SlackChannel]> = [];
		for (const [channelId, channel] of this.channels) {
			const logPath = join(this.workingDir, channelId, "log.jsonl");
			if (existsSync(logPath)) {
				channelsToBackfill.push([channelId, channel]);
			}
		}

		log.logBackfillStart(channelsToBackfill.length);

		let totalMessages = 0;
		for (const [channelId, channel] of channelsToBackfill) {
			try {
				const count = await this.backfillChannel(channelId);
				if (count > 0) log.logBackfillChannel(channel.name, count);
				totalMessages += count;
			} catch (error) {
				log.logWarning(`Failed to backfill #${channel.name}`, String(error));
			}
		}

		const durationMs = Date.now() - startTime;
		log.logBackfillComplete(totalMessages, durationMs);
	}

	// ==========================================================================
	// Private - Fetch Users/Channels
	// ==========================================================================

	/**
	 * 从 Slack API 加载所有用户（分页获取）
	 * 过滤掉已删除的用户
	 */
	private async fetchUsers(): Promise<void> {
		let cursor: string | undefined;
		do {
			const result = await this.webClient.users.list({ limit: 200, cursor });
			const members = result.members as
				| Array<{ id?: string; name?: string; real_name?: string; deleted?: boolean }>
				| undefined;
			if (members) {
				for (const u of members) {
					if (u.id && u.name && !u.deleted) {
						this.users.set(u.id, { id: u.id, userName: u.name, displayName: u.real_name || u.name });
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);
	}

	/**
	 * 从 Slack API 加载所有频道和 DM 会话（分页获取）
	 * 频道仅加载已加入的（is_member），DM 使用对方用户名作为频道名
	 */
	private async fetchChannels(): Promise<void> {
		// 获取公共/私有频道
		let cursor: string | undefined;
		do {
			const result = await this.webClient.conversations.list({
				types: "public_channel,private_channel",
				exclude_archived: true,
				limit: 200,
				cursor,
			});
			const channels = result.channels as Array<{ id?: string; name?: string; is_member?: boolean }> | undefined;
			if (channels) {
				for (const c of channels) {
					// 只添加已加入的频道
					if (c.id && c.name && c.is_member) {
						this.channels.set(c.id, { id: c.id, name: c.name });
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);

		// 获取 DM 会话
		cursor = undefined;
		do {
			const result = await this.webClient.conversations.list({
				types: "im",
				limit: 200,
				cursor,
			});
			const ims = result.channels as Array<{ id?: string; user?: string }> | undefined;
			if (ims) {
				for (const im of ims) {
					if (im.id) {
						// DM 使用对方用户名作为频道名称
						const user = im.user ? this.users.get(im.user) : undefined;
						const name = user ? `DM:${user.userName}` : `DM:${im.id}`;
						this.channels.set(im.id, { id: im.id, name });
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);
	}
}
