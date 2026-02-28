/**
 * @file download.ts - 频道历史记录下载工具
 *
 * 本文件提供独立的频道历史记录下载功能（通过 --download 命令行参数触发）。
 * 功能包括：
 * 1. 从 Slack API 拉取指定频道的所有消息历史
 * 2. 获取每条消息的线程回复
 * 3. 按时间顺序输出到 stdout，线程回复缩进显示
 * 4. 将诊断信息输出到 stderr，便于管道和重定向使用
 */

import { LogLevel, WebClient } from "@slack/web-api";

/**
 * Slack 消息结构（简化版）
 */
interface Message {
	/** 消息时间戳 */
	ts: string;
	/** 发送者用户 ID */
	user?: string;
	/** 消息文本内容 */
	text?: string;
	/** 线程父消息的时间戳 */
	thread_ts?: string;
	/** 线程回复数量 */
	reply_count?: number;
	/** 附件文件列表 */
	files?: Array<{ name: string; url_private?: string }>;
}

/**
 * 将 Slack 时间戳格式化为可读日期字符串
 * @param ts - Slack 消息时间戳（如 "1234567890.123456"）
 * @returns 格式化后的日期字符串（如 "2025-01-15 10:30:45"）
 */
function formatTs(ts: string): string {
	const date = new Date(parseFloat(ts) * 1000);
	return date
		.toISOString()
		.replace("T", " ")
		.replace(/\.\d+Z$/, "");
}

/**
 * 格式化单条消息为可读字符串
 * 支持多行消息，续行会自动对齐到内容起始位置
 * @param ts - 消息时间戳
 * @param user - 用户 ID
 * @param text - 消息文本
 * @param indent - 前缀缩进（线程回复使用 "  "）
 * @returns 格式化后的消息字符串
 */
function formatMessage(ts: string, user: string, text: string, indent = ""): string {
	const prefix = `[${formatTs(ts)}] ${user}: `;
	const lines = text.split("\n");
	const firstLine = `${indent}${prefix}${lines[0]}`;
	if (lines.length === 1) return firstLine;
	// 续行使用与内容起始位置相同的缩进
	const contentIndent = indent + " ".repeat(prefix.length);
	return [firstLine, ...lines.slice(1).map((l) => contentIndent + l)].join("\n");
}

/**
 * 下载指定频道的完整历史记录并输出到 stdout
 *
 * 工作流程：
 * 1. 获取频道信息（名称）
 * 2. 分页拉取所有消息
 * 3. 识别有线程回复的消息，逐一获取回复
 * 4. 按时间顺序输出消息，线程回复紧跟在父消息之后（缩进显示）
 *
 * @param channelId - Slack 频道 ID
 * @param botToken - Slack Bot Token（用于 API 认证）
 */
export async function downloadChannel(channelId: string, botToken: string): Promise<void> {
	const client = new WebClient(botToken, { logLevel: LogLevel.ERROR });

	console.error(`Fetching channel info for ${channelId}...`);

	// 获取频道信息
	let channelName = channelId;
	try {
		const info = await client.conversations.info({ channel: channelId });
		channelName = (info.channel as any)?.name || channelId;
	} catch {
		// DM 频道没有名称，这是正常的
	}

	console.error(`Downloading history for #${channelName} (${channelId})...`);

	// 分页拉取所有消息
	const messages: Message[] = [];
	let cursor: string | undefined;

	do {
		const response = await client.conversations.history({
			channel: channelId,
			limit: 200,
			cursor,
		});

		if (response.messages) {
			messages.push(...(response.messages as Message[]));
		}

		cursor = response.response_metadata?.next_cursor;
		console.error(`  Fetched ${messages.length} messages...`);
	} while (cursor);

	// 反转为时间顺序（API 返回的是逆序）
	messages.reverse();

	// 获取有回复的消息的线程内容
	const threadReplies = new Map<string, Message[]>();
	const threadsToFetch = messages.filter((m) => m.reply_count && m.reply_count > 0);

	console.error(`Fetching ${threadsToFetch.length} threads...`);

	for (let i = 0; i < threadsToFetch.length; i++) {
		const parent = threadsToFetch[i];
		console.error(`  Thread ${i + 1}/${threadsToFetch.length} (${parent.reply_count} replies)...`);

		const replies: Message[] = [];
		let threadCursor: string | undefined;

		// 分页拉取线程回复
		do {
			const response = await client.conversations.replies({
				channel: channelId,
				ts: parent.ts,
				limit: 200,
				cursor: threadCursor,
			});

			if (response.messages) {
				// 跳过第一条消息（它是父消息本身）
				replies.push(...(response.messages as Message[]).slice(1));
			}

			threadCursor = response.response_metadata?.next_cursor;
		} while (threadCursor);

		threadReplies.set(parent.ts, replies);
	}

	// 输出消息，线程回复交织在父消息之后
	let totalReplies = 0;
	for (const msg of messages) {
		// 输出主消息
		console.log(formatMessage(msg.ts, msg.user || "unknown", msg.text || ""));

		// 输出线程回复（缩进显示）
		const replies = threadReplies.get(msg.ts);
		if (replies) {
			for (const reply of replies) {
				console.log(formatMessage(reply.ts, reply.user || "unknown", reply.text || "", "  "));
				totalReplies++;
			}
		}
	}

	console.error(`Done! ${messages.length} messages, ${totalReplies} thread replies`);
}
