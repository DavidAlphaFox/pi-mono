/**
 * @file store.ts - 频道数据存储模块
 *
 * 本文件负责：
 * 1. 管理每个频道的本地数据目录（log.jsonl、attachments/）
 * 2. 处理 Slack 附件的下载：接收文件元信息，生成本地文件名，排队后台下载
 * 3. 提供消息日志的读写功能（logMessage、logBotResponse）
 * 4. 实现消息去重（基于频道+时间戳，60 秒内有效）
 * 5. 获取频道最后一条消息的时间戳（用于回填判断）
 */

import { existsSync, mkdirSync, readFileSync } from "fs";
import { appendFile, writeFile } from "fs/promises";
import { join } from "path";
import * as log from "./log.js";

/**
 * 附件信息
 */
export interface Attachment {
	/** 上传者的原始文件名 */
	original: string;
	/** 相对于工作目录的本地路径（如 "C12345/attachments/1732531234567_file.png"） */
	local: string;
}

/**
 * 已记录的消息结构
 * 存储在 log.jsonl 中的每一行的格式
 */
export interface LoggedMessage {
	/** ISO 8601 格式日期（如 "2025-11-26T10:44:00.000Z"），便于 grep 搜索 */
	date: string;
	/** Slack 时间戳或毫秒级 epoch 时间 */
	ts: string;
	/** 用户 ID（机器人响应为 "bot"） */
	user: string;
	/** 用户名/handle（如 "mario"） */
	userName?: string;
	/** 显示名称（如 "Mario Zechner"） */
	displayName?: string;
	/** 消息文本内容 */
	text: string;
	/** 附件列表 */
	attachments: Attachment[];
	/** 是否为机器人消息 */
	isBot: boolean;
}

/**
 * 频道存储配置
 */
export interface ChannelStoreConfig {
	/** 工作目录路径 */
	workingDir: string;
	/** Slack Bot Token，用于认证下载附件 */
	botToken: string;
}

/**
 * 待下载的附件信息
 */
interface PendingDownload {
	/** 频道 ID */
	channelId: string;
	/** 本地相对路径 */
	localPath: string;
	/** 下载 URL */
	url: string;
}

/**
 * 频道数据存储类
 * 管理消息日志、附件下载和频道目录结构
 */
export class ChannelStore {
	/** 工作目录路径 */
	private workingDir: string;
	/** Slack Bot Token */
	private botToken: string;
	/** 待下载的附件队列 */
	private pendingDownloads: PendingDownload[] = [];
	/** 是否正在下载中 */
	private isDownloading = false;
	/**
	 * 最近已记录的消息时间戳缓存，用于防止重复记录
	 * Key 格式: "channelId:ts"，60 秒后自动清理
	 */
	private recentlyLogged = new Map<string, number>();

	/**
	 * @param config - 存储配置（工作目录和 Bot Token）
	 */
	constructor(config: ChannelStoreConfig) {
		this.workingDir = config.workingDir;
		this.botToken = config.botToken;

		// 确保工作目录存在
		if (!existsSync(this.workingDir)) {
			mkdirSync(this.workingDir, { recursive: true });
		}
	}

	/**
	 * 获取或创建频道的数据目录
	 * @param channelId - 频道 ID
	 * @returns 频道目录的绝对路径
	 */
	getChannelDir(channelId: string): string {
		const dir = join(this.workingDir, channelId);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		return dir;
	}

	/**
	 * 生成附件的唯一本地文件名
	 * 格式: "{毫秒时间戳}_{清理后的文件名}"
	 * @param originalName - 原始文件名
	 * @param timestamp - Slack 消息时间戳
	 * @returns 生成的文件名
	 */
	generateLocalFilename(originalName: string, timestamp: string): string {
		// 将 Slack 时间戳（1234567890.123456）转换为毫秒
		const ts = Math.floor(parseFloat(timestamp) * 1000);
		// 清理原始文件名（移除特殊字符）
		const sanitized = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
		return `${ts}_${sanitized}`;
	}

	/**
	 * 处理 Slack 消息中的附件
	 * 生成本地文件名和路径，并将下载任务排队到后台处理
	 * @param channelId - 频道 ID
	 * @param files - Slack 文件列表
	 * @param timestamp - 消息时间戳
	 * @returns 附件元信息列表（包含本地路径）
	 */
	processAttachments(
		channelId: string,
		files: Array<{ name?: string; url_private_download?: string; url_private?: string }>,
		timestamp: string,
	): Attachment[] {
		const attachments: Attachment[] = [];

		for (const file of files) {
			const url = file.url_private_download || file.url_private;
			if (!url) continue;
			if (!file.name) {
				log.logWarning("Attachment missing name, skipping", url);
				continue;
			}

			const filename = this.generateLocalFilename(file.name, timestamp);
			const localPath = `${channelId}/attachments/${filename}`;

			attachments.push({
				original: file.name,
				local: localPath,
			});

			// 将下载任务加入后台队列
			this.pendingDownloads.push({ channelId, localPath, url });
		}

		// 触发后台下载处理
		this.processDownloadQueue();

		return attachments;
	}

	/**
	 * 将消息记录到频道的 log.jsonl
	 * 具有去重功能：同一频道+时间戳的消息 60 秒内不会重复记录
	 * @param channelId - 频道 ID
	 * @param message - 要记录的消息
	 * @returns 是否成功记录（false 表示重复消息）
	 */
	async logMessage(channelId: string, message: LoggedMessage): Promise<boolean> {
		// 检查是否重复（相同频道 + 时间戳）
		const dedupeKey = `${channelId}:${message.ts}`;
		if (this.recentlyLogged.has(dedupeKey)) {
			return false; // 已记录过
		}

		// 标记为已记录，60 秒后自动清理
		this.recentlyLogged.set(dedupeKey, Date.now());
		setTimeout(() => this.recentlyLogged.delete(dedupeKey), 60000);

		const logPath = join(this.getChannelDir(channelId), "log.jsonl");

		// 确保消息有日期字段
		if (!message.date) {
			let date: Date;
			if (message.ts.includes(".")) {
				// Slack 时间戳格式（1234567890.123456）
				date = new Date(parseFloat(message.ts) * 1000);
			} else {
				// 毫秒级 epoch 时间
				date = new Date(parseInt(message.ts, 10));
			}
			message.date = date.toISOString();
		}

		const line = `${JSON.stringify(message)}\n`;
		await appendFile(logPath, line, "utf-8");
		return true;
	}

	/**
	 * 记录机器人响应到 log.jsonl
	 * @param channelId - 频道 ID
	 * @param text - 响应文本
	 * @param ts - 消息时间戳
	 */
	async logBotResponse(channelId: string, text: string, ts: string): Promise<void> {
		await this.logMessage(channelId, {
			date: new Date().toISOString(),
			ts,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
		});
	}

	/**
	 * 获取频道最后一条消息的时间戳
	 * 用于判断回填的起始位置
	 * @param channelId - 频道 ID
	 * @returns 最后一条消息的时间戳，无日志则返回 null
	 */
	getLastTimestamp(channelId: string): string | null {
		const logPath = join(this.workingDir, channelId, "log.jsonl");
		if (!existsSync(logPath)) {
			return null;
		}

		try {
			const content = readFileSync(logPath, "utf-8");
			const lines = content.trim().split("\n");
			if (lines.length === 0 || lines[0] === "") {
				return null;
			}
			const lastLine = lines[lines.length - 1];
			const message = JSON.parse(lastLine) as LoggedMessage;
			return message.ts;
		} catch {
			return null;
		}
	}

	/**
	 * 后台处理附件下载队列
	 * 串行下载所有待处理的附件，避免并发问题
	 */
	private async processDownloadQueue(): Promise<void> {
		if (this.isDownloading || this.pendingDownloads.length === 0) return;

		this.isDownloading = true;

		while (this.pendingDownloads.length > 0) {
			const item = this.pendingDownloads.shift();
			if (!item) break;

			try {
				await this.downloadAttachment(item.localPath, item.url);
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				log.logWarning(`Failed to download attachment`, `${item.localPath}: ${errorMsg}`);
			}
		}

		this.isDownloading = false;
	}

	/**
	 * 下载单个附件
	 * 使用 Bot Token 进行认证，将文件保存到本地路径
	 * @param localPath - 相对于工作目录的本地路径
	 * @param url - 下载 URL（Slack 私有链接）
	 */
	private async downloadAttachment(localPath: string, url: string): Promise<void> {
		const filePath = join(this.workingDir, localPath);

		// 确保目标目录存在
		const dir = join(this.workingDir, localPath.substring(0, localPath.lastIndexOf("/")));
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		// 使用 Bot Token 认证下载
		const response = await fetch(url, {
			headers: {
				Authorization: `Bearer ${this.botToken}`,
			},
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		const buffer = await response.arrayBuffer();
		await writeFile(filePath, Buffer.from(buffer));
	}
}
