/**
 * @file context.ts - 上下文管理模块
 *
 * Mom 为每个频道维护两个文件：
 * - context.jsonl: 结构化的 API 消息，用于 LLM 上下文（与 coding-agent 会话格式相同）
 * - log.jsonl: 人类可读的频道历史记录，用于 grep 搜索（不包含工具结果）
 *
 * 本模块提供：
 * - syncLogToSessionManager: 将 log.jsonl 中的消息同步到 SessionManager
 * - MomSettingsManager: Mom 的简易设置管理（上下文压缩、重试、模型偏好）
 */

import type { UserMessage } from "@mariozechner/pi-ai";
import type { SessionManager, SessionMessageEntry } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

// ============================================================================
// Sync log.jsonl to SessionManager
// ============================================================================

/**
 * log.jsonl 中的消息结构
 */
interface LogMessage {
	/** ISO 8601 格式的日期 */
	date?: string;
	/** Slack 消息时间戳 */
	ts?: string;
	/** 用户 ID */
	user?: string;
	/** 用户名 */
	userName?: string;
	/** 消息文本 */
	text?: string;
	/** 是否为机器人消息 */
	isBot?: boolean;
}

/**
 * 将 log.jsonl 中的用户消息同步到 SessionManager
 *
 * 确保在 mom 未运行期间（频道聊天、回填的消息、忙碌时的消息）
 * 也能被添加到 LLM 上下文中。
 *
 * @param sessionManager - 要同步到的 SessionManager 实例
 * @param channelDir - 包含 log.jsonl 的频道目录路径
 * @param excludeSlackTs - 当前消息的 Slack 时间戳（将通过 prompt() 添加，不在同步中重复添加）
 * @returns 同步的消息数量
 */
export function syncLogToSessionManager(
	sessionManager: SessionManager,
	channelDir: string,
	excludeSlackTs?: string,
): number {
	const logFile = join(channelDir, "log.jsonl");

	if (!existsSync(logFile)) return 0;

	// 构建已有消息内容的集合，用于去重
	const existingMessages = new Set<string>();
	for (const entry of sessionManager.getEntries()) {
		if (entry.type === "message") {
			const msgEntry = entry as SessionMessageEntry;
			const msg = msgEntry.message as { role: string; content?: unknown };
			if (msg.role === "user" && msg.content !== undefined) {
				const content = msg.content;
				if (typeof content === "string") {
					// 去除时间戳前缀用于比较（实时消息有时间戳，同步的没有）
					// 格式: [YYYY-MM-DD HH:MM:SS+HH:MM] [username]: text
					let normalized = content.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] /, "");
					// 去除附件部分
					const attachmentsIdx = normalized.indexOf("\n\n<slack_attachments>\n");
					if (attachmentsIdx !== -1) {
						normalized = normalized.substring(0, attachmentsIdx);
					}
					existingMessages.add(normalized);
				} else if (Array.isArray(content)) {
					// 处理多部分内容格式
					for (const part of content) {
						if (
							typeof part === "object" &&
							part !== null &&
							"type" in part &&
							part.type === "text" &&
							"text" in part
						) {
							let normalized = (part as { type: "text"; text: string }).text;
							normalized = normalized.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] /, "");
							const attachmentsIdx = normalized.indexOf("\n\n<slack_attachments>\n");
							if (attachmentsIdx !== -1) {
								normalized = normalized.substring(0, attachmentsIdx);
							}
							existingMessages.add(normalized);
						}
					}
				}
			}
		}
	}

	// 读取 log.jsonl，找出不在上下文中的用户消息
	const logContent = readFileSync(logFile, "utf-8");
	const logLines = logContent.trim().split("\n").filter(Boolean);

	const newMessages: Array<{ timestamp: number; message: UserMessage }> = [];

	for (const line of logLines) {
		try {
			const logMsg: LogMessage = JSON.parse(line);

			const slackTs = logMsg.ts;
			const date = logMsg.date;
			if (!slackTs || !date) continue;

			// 跳过当前正在处理的消息（将通过 prompt() 添加）
			if (excludeSlackTs && slackTs === excludeSlackTs) continue;

			// 跳过机器人消息 - 这些通过 Agent 流程添加
			if (logMsg.isBot) continue;

			// 构建消息文本（与上下文中的格式一致）
			const messageText = `[${logMsg.userName || logMsg.user || "unknown"}]: ${logMsg.text || ""}`;

			// 如果此消息已在上下文中，跳过
			if (existingMessages.has(messageText)) continue;

			const msgTime = new Date(date).getTime() || Date.now();
			const userMessage: UserMessage = {
				role: "user",
				content: [{ type: "text", text: messageText }],
				timestamp: msgTime,
			};

			newMessages.push({ timestamp: msgTime, message: userMessage });
			existingMessages.add(messageText); // 标记已处理，避免本次同步内重复
		} catch {
			// 跳过格式错误的行
		}
	}

	if (newMessages.length === 0) return 0;

	// 按时间戳排序后添加到会话
	newMessages.sort((a, b) => a.timestamp - b.timestamp);

	for (const { message } of newMessages) {
		sessionManager.appendMessage(message);
	}

	return newMessages.length;
}

// ============================================================================
// MomSettingsManager - Simple settings for mom
// ============================================================================

/**
 * 上下文压缩设置
 */
export interface MomCompactionSettings {
	/** 是否启用自动压缩 */
	enabled: boolean;
	/** 压缩后保留的 Token 预算 */
	reserveTokens: number;
	/** 保留最近的 Token 数量（不压缩） */
	keepRecentTokens: number;
}

/**
 * API 调用重试设置
 */
export interface MomRetrySettings {
	/** 是否启用自动重试 */
	enabled: boolean;
	/** 最大重试次数 */
	maxRetries: number;
	/** 基础延迟毫秒数（指数退避） */
	baseDelayMs: number;
}

/**
 * Mom 设置结构
 */
export interface MomSettings {
	/** 默认 AI 提供商 */
	defaultProvider?: string;
	/** 默认模型 ID */
	defaultModel?: string;
	/** 默认思考级别 */
	defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
	/** 上下文压缩设置 */
	compaction?: Partial<MomCompactionSettings>;
	/** 重试设置 */
	retry?: Partial<MomRetrySettings>;
}

/** 默认上下文压缩设置 */
const DEFAULT_COMPACTION: MomCompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

/** 默认重试设置 */
const DEFAULT_RETRY: MomRetrySettings = {
	enabled: true,
	maxRetries: 3,
	baseDelayMs: 2000,
};

/**
 * Mom 设置管理器
 * 在工作区根目录存储 settings.json 文件，管理压缩、重试、模型等配置
 */
export class MomSettingsManager {
	/** 设置文件路径 */
	private settingsPath: string;
	/** 当前设置 */
	private settings: MomSettings;

	/**
	 * @param workspaceDir - 工作区目录路径
	 */
	constructor(workspaceDir: string) {
		this.settingsPath = join(workspaceDir, "settings.json");
		this.settings = this.load();
	}

	/**
	 * 从文件加载设置
	 * @returns 设置对象，文件不存在或解析失败时返回空对象
	 */
	private load(): MomSettings {
		if (!existsSync(this.settingsPath)) {
			return {};
		}

		try {
			const content = readFileSync(this.settingsPath, "utf-8");
			return JSON.parse(content);
		} catch {
			return {};
		}
	}

	/**
	 * 将当前设置保存到文件
	 */
	private save(): void {
		try {
			const dir = dirname(this.settingsPath);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2), "utf-8");
		} catch (error) {
			console.error(`Warning: Could not save settings file: ${error}`);
		}
	}

	/**
	 * 获取上下文压缩设置（合并默认值）
	 * @returns 完整的压缩设置
	 */
	getCompactionSettings(): MomCompactionSettings {
		return {
			...DEFAULT_COMPACTION,
			...this.settings.compaction,
		};
	}

	/**
	 * 获取是否启用上下文压缩
	 * @returns 是否启用
	 */
	getCompactionEnabled(): boolean {
		return this.settings.compaction?.enabled ?? DEFAULT_COMPACTION.enabled;
	}

	/**
	 * 设置是否启用上下文压缩
	 * @param enabled - 是否启用
	 */
	setCompactionEnabled(enabled: boolean): void {
		this.settings.compaction = { ...this.settings.compaction, enabled };
		this.save();
	}

	/**
	 * 获取重试设置（合并默认值）
	 * @returns 完整的重试设置
	 */
	getRetrySettings(): MomRetrySettings {
		return {
			...DEFAULT_RETRY,
			...this.settings.retry,
		};
	}

	/**
	 * 获取是否启用自动重试
	 * @returns 是否启用
	 */
	getRetryEnabled(): boolean {
		return this.settings.retry?.enabled ?? DEFAULT_RETRY.enabled;
	}

	/**
	 * 设置是否启用自动重试
	 * @param enabled - 是否启用
	 */
	setRetryEnabled(enabled: boolean): void {
		this.settings.retry = { ...this.settings.retry, enabled };
		this.save();
	}

	/**
	 * 获取默认模型 ID
	 * @returns 模型 ID 或 undefined
	 */
	getDefaultModel(): string | undefined {
		return this.settings.defaultModel;
	}

	/**
	 * 获取默认 AI 提供商
	 * @returns 提供商名称或 undefined
	 */
	getDefaultProvider(): string | undefined {
		return this.settings.defaultProvider;
	}

	/**
	 * 设置默认模型和提供商
	 * @param provider - 提供商名称
	 * @param modelId - 模型 ID
	 */
	setDefaultModelAndProvider(provider: string, modelId: string): void {
		this.settings.defaultProvider = provider;
		this.settings.defaultModel = modelId;
		this.save();
	}

	/**
	 * 获取默认思考级别
	 * @returns 思考级别字符串，默认为 "off"
	 */
	getDefaultThinkingLevel(): string {
		return this.settings.defaultThinkingLevel || "off";
	}

	/**
	 * 设置默认思考级别
	 * @param level - 思考级别
	 */
	setDefaultThinkingLevel(level: string): void {
		this.settings.defaultThinkingLevel = level as MomSettings["defaultThinkingLevel"];
		this.save();
	}

	// ---- AgentSession 兼容方法 ----

	/**
	 * 获取 steering 模式
	 * @returns 始终返回 "one-at-a-time"，Mom 每次只处理一条消息
	 */
	getSteeringMode(): "all" | "one-at-a-time" {
		return "one-at-a-time"; // Mom 每次只处理一条消息
	}

	/**
	 * 设置 steering 模式（无操作）
	 */
	setSteeringMode(_mode: "all" | "one-at-a-time"): void {
		// Mom 不使用此设置
	}

	/**
	 * 获取 follow-up 模式
	 * @returns 始终返回 "one-at-a-time"
	 */
	getFollowUpMode(): "all" | "one-at-a-time" {
		return "one-at-a-time"; // Mom 每次只处理一条消息
	}

	/**
	 * 设置 follow-up 模式（无操作）
	 */
	setFollowUpMode(_mode: "all" | "one-at-a-time"): void {
		// Mom 不使用此设置
	}

	/**
	 * 获取 hook 路径列表
	 * @returns 空数组，Mom 不使用 hooks
	 */
	getHookPaths(): string[] {
		return []; // Mom 不使用 hooks
	}

	/**
	 * 获取 hook 超时时间
	 * @returns 30000 毫秒
	 */
	getHookTimeout(): number {
		return 30000;
	}
}
