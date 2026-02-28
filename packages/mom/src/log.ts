/**
 * @file log.ts - 控制台日志输出模块
 *
 * 本文件负责：
 * 1. 提供统一的彩色控制台日志输出（使用 chalk 库）
 * 2. 格式化日志上下文（频道名、用户名、时间戳）
 * 3. 记录各类事件：用户消息、工具执行、响应流、附件下载、停止请求、用量统计等
 * 4. 支持文本截断和缩进格式化
 *
 * 日志颜色约定：
 * - 绿色：用户消息
 * - 黄色：工具执行、响应、下载、停止等操作
 * - 蓝色：系统信息
 */

import chalk from "chalk";

/**
 * 日志上下文信息
 * 用于标识日志来源的频道和用户
 */
export interface LogContext {
	/** 频道 ID */
	channelId: string;
	/** 用户名 */
	userName?: string;
	/** 频道名称（如 #dev-team），用于替代原始 ID 显示 */
	channelName?: string;
}

/**
 * 生成当前时间戳字符串
 * @returns 格式为 [HH:MM:SS] 的时间戳
 */
function timestamp(): string {
	const now = new Date();
	const hh = String(now.getHours()).padStart(2, "0");
	const mm = String(now.getMinutes()).padStart(2, "0");
	const ss = String(now.getSeconds()).padStart(2, "0");
	return `[${hh}:${mm}:${ss}]`;
}

/**
 * 格式化日志上下文为可读字符串
 * DM 显示为 [DM:username]，频道显示为 [#channel-name:username]
 * @param ctx - 日志上下文
 * @returns 格式化后的上下文字符串
 */
function formatContext(ctx: LogContext): string {
	if (ctx.channelId.startsWith("D")) {
		return `[DM:${ctx.userName || ctx.channelId}]`;
	}
	const channel = ctx.channelName || ctx.channelId;
	const user = ctx.userName || "unknown";
	return `[${channel.startsWith("#") ? channel : `#${channel}`}:${user}]`;
}

/**
 * 截断文本到指定最大长度
 * 超长文本在截断处添加提示信息
 * @param text - 原始文本
 * @param maxLen - 最大字符数
 * @returns 截断后的文本
 */
function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.substring(0, maxLen)}\n(truncated at ${maxLen} chars)`;
}

/**
 * 格式化工具调用参数为可读字符串
 * 跳过 label 参数，对 path+offset/limit 做特殊处理
 * @param args - 工具参数对象
 * @returns 格式化后的参数字符串
 */
function formatToolArgs(args: Record<string, unknown>): string {
	const lines: string[] = [];

	for (const [key, value] of Object.entries(args)) {
		// 跳过 label - 已在工具名中显示
		if (key === "label") continue;

		// 对 read 工具的 path 参数做特殊格式化（包含行范围）
		if (key === "path" && typeof value === "string") {
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset !== undefined && limit !== undefined) {
				lines.push(`${value}:${offset}-${offset + limit}`);
			} else {
				lines.push(value);
			}
			continue;
		}

		// 跳过 offset/limit（已在 path 中处理）
		if (key === "offset" || key === "limit") continue;

		if (typeof value === "string") {
			lines.push(value);
		} else {
			lines.push(JSON.stringify(value));
		}
	}

	return lines.join("\n");
}

/**
 * 记录用户消息
 * @param ctx - 日志上下文
 * @param text - 消息文本
 */
export function logUserMessage(ctx: LogContext, text: string): void {
	console.log(chalk.green(`${timestamp()} ${formatContext(ctx)} ${text}`));
}

/**
 * 记录工具开始执行
 * @param ctx - 日志上下文
 * @param toolName - 工具名称
 * @param label - 用户可见的标签
 * @param args - 工具参数
 */
export function logToolStart(ctx: LogContext, toolName: string, label: string, args: Record<string, unknown>): void {
	const formattedArgs = formatToolArgs(args);
	console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} ↳ ${toolName}: ${label}`));
	if (formattedArgs) {
		// 缩进参数内容
		const indented = formattedArgs
			.split("\n")
			.map((line) => `           ${line}`)
			.join("\n");
		console.log(chalk.dim(indented));
	}
}

/**
 * 记录工具执行成功
 * @param ctx - 日志上下文
 * @param toolName - 工具名称
 * @param durationMs - 执行耗时（毫秒）
 * @param result - 执行结果文本
 */
export function logToolSuccess(ctx: LogContext, toolName: string, durationMs: number, result: string): void {
	const duration = (durationMs / 1000).toFixed(1);
	console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} ✓ ${toolName} (${duration}s)`));

	const truncated = truncate(result, 1000);
	if (truncated) {
		const indented = truncated
			.split("\n")
			.map((line) => `           ${line}`)
			.join("\n");
		console.log(chalk.dim(indented));
	}
}

/**
 * 记录工具执行出错
 * @param ctx - 日志上下文
 * @param toolName - 工具名称
 * @param durationMs - 执行耗时（毫秒）
 * @param error - 错误信息
 */
export function logToolError(ctx: LogContext, toolName: string, durationMs: number, error: string): void {
	const duration = (durationMs / 1000).toFixed(1);
	console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} ✗ ${toolName} (${duration}s)`));

	const truncated = truncate(error, 1000);
	const indented = truncated
		.split("\n")
		.map((line) => `           ${line}`)
		.join("\n");
	console.log(chalk.dim(indented));
}

/**
 * 记录响应流开始
 * @param ctx - 日志上下文
 */
export function logResponseStart(ctx: LogContext): void {
	console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} → Streaming response...`));
}

/**
 * 记录 LLM 的思考过程
 * @param ctx - 日志上下文
 * @param thinking - 思考内容文本
 */
export function logThinking(ctx: LogContext, thinking: string): void {
	console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} 💭 Thinking`));
	const truncated = truncate(thinking, 1000);
	const indented = truncated
		.split("\n")
		.map((line) => `           ${line}`)
		.join("\n");
	console.log(chalk.dim(indented));
}

/**
 * 记录 LLM 的文本响应
 * @param ctx - 日志上下文
 * @param text - 响应文本
 */
export function logResponse(ctx: LogContext, text: string): void {
	console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} 💬 Response`));
	const truncated = truncate(text, 1000);
	const indented = truncated
		.split("\n")
		.map((line) => `           ${line}`)
		.join("\n");
	console.log(chalk.dim(indented));
}

/**
 * 记录附件下载开始
 * @param ctx - 日志上下文
 * @param filename - 文件名
 * @param localPath - 本地保存路径
 */
export function logDownloadStart(ctx: LogContext, filename: string, localPath: string): void {
	console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} ↓ Downloading attachment`));
	console.log(chalk.dim(`           ${filename} → ${localPath}`));
}

/**
 * 记录附件下载成功
 * @param ctx - 日志上下文
 * @param sizeKB - 文件大小（KB）
 */
export function logDownloadSuccess(ctx: LogContext, sizeKB: number): void {
	console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} ✓ Downloaded (${sizeKB.toLocaleString()} KB)`));
}

/**
 * 记录附件下载失败
 * @param ctx - 日志上下文
 * @param filename - 文件名
 * @param error - 错误信息
 */
export function logDownloadError(ctx: LogContext, filename: string, error: string): void {
	console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} ✗ Download failed`));
	console.log(chalk.dim(`           ${filename}: ${error}`));
}

/**
 * 记录停止请求
 * @param ctx - 日志上下文
 */
export function logStopRequest(ctx: LogContext): void {
	console.log(chalk.green(`${timestamp()} ${formatContext(ctx)} stop`));
	console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} ⊗ Stop requested - aborting`));
}

/**
 * 记录系统信息
 * @param message - 信息内容
 */
export function logInfo(message: string): void {
	console.log(chalk.blue(`${timestamp()} [system] ${message}`));
}

/**
 * 记录系统警告
 * @param message - 警告信息
 * @param details - 详细信息（可选）
 */
export function logWarning(message: string, details?: string): void {
	console.log(chalk.yellow(`${timestamp()} [system] ⚠ ${message}`));
	if (details) {
		const indented = details
			.split("\n")
			.map((line) => `           ${line}`)
			.join("\n");
		console.log(chalk.dim(indented));
	}
}

/**
 * 记录 Agent 错误
 * @param ctx - 日志上下文或 "system" 表示系统级错误
 * @param error - 错误信息
 */
export function logAgentError(ctx: LogContext | "system", error: string): void {
	const context = ctx === "system" ? "[system]" : formatContext(ctx);
	console.log(chalk.yellow(`${timestamp()} ${context} ✗ Agent error`));
	const indented = error
		.split("\n")
		.map((line) => `           ${line}`)
		.join("\n");
	console.log(chalk.dim(indented));
}

/**
 * 记录 Token 用量摘要并生成 Slack 格式的摘要文本
 * @param ctx - 日志上下文
 * @param usage - Token 用量信息
 * @param contextTokens - 当前上下文 Token 数（可选）
 * @param contextWindow - 模型上下文窗口大小（可选）
 * @returns Slack 格式的用量摘要字符串
 */
export function logUsageSummary(
	ctx: LogContext,
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	},
	contextTokens?: number,
	contextWindow?: number,
): string {
	/**
	 * 将 Token 数格式化为可读字符串
	 * @param count - Token 数
	 * @returns 格式化后的字符串（如 "1.5k"、"100k"、"1.2M"）
	 */
	const formatTokens = (count: number): string => {
		if (count < 1000) return count.toString();
		if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
		if (count < 1000000) return `${Math.round(count / 1000)}k`;
		return `${(count / 1000000).toFixed(1)}M`;
	};

	// 构建 Slack 格式的摘要
	const lines: string[] = [];
	lines.push("*Usage Summary*");
	lines.push(`Tokens: ${usage.input.toLocaleString()} in, ${usage.output.toLocaleString()} out`);
	if (usage.cacheRead > 0 || usage.cacheWrite > 0) {
		lines.push(`Cache: ${usage.cacheRead.toLocaleString()} read, ${usage.cacheWrite.toLocaleString()} write`);
	}
	if (contextTokens && contextWindow) {
		const contextPercent = ((contextTokens / contextWindow) * 100).toFixed(1);
		lines.push(`Context: ${formatTokens(contextTokens)} / ${formatTokens(contextWindow)} (${contextPercent}%)`);
	}
	lines.push(
		`Cost: $${usage.cost.input.toFixed(4)} in, $${usage.cost.output.toFixed(4)} out` +
			(usage.cacheRead > 0 || usage.cacheWrite > 0
				? `, $${usage.cost.cacheRead.toFixed(4)} cache read, $${usage.cost.cacheWrite.toFixed(4)} cache write`
				: ""),
	);
	lines.push(`*Total: $${usage.cost.total.toFixed(4)}*`);

	const summary = lines.join("\n");

	// 同时输出到控制台
	console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} 💰 Usage`));
	console.log(
		chalk.dim(
			`           ${usage.input.toLocaleString()} in + ${usage.output.toLocaleString()} out` +
				(usage.cacheRead > 0 || usage.cacheWrite > 0
					? ` (${usage.cacheRead.toLocaleString()} cache read, ${usage.cacheWrite.toLocaleString()} cache write)`
					: "") +
				` = $${usage.cost.total.toFixed(4)}`,
		),
	);

	return summary;
}

/**
 * 记录启动信息
 * @param workingDir - 工作目录路径
 * @param sandbox - 沙盒模式描述
 */
export function logStartup(workingDir: string, sandbox: string): void {
	console.log("Starting mom bot...");
	console.log(`  Working directory: ${workingDir}`);
	console.log(`  Sandbox: ${sandbox}`);
}

/**
 * 记录已连接并开始监听
 */
export function logConnected(): void {
	console.log("⚡️ Mom bot connected and listening!");
	console.log("");
}

/**
 * 记录已断开连接
 */
export function logDisconnected(): void {
	console.log("Mom bot disconnected.");
}

/**
 * 记录回填开始
 * @param channelCount - 需要回填的频道数量
 */
export function logBackfillStart(channelCount: number): void {
	console.log(chalk.blue(`${timestamp()} [system] Backfilling ${channelCount} channels...`));
}

/**
 * 记录单个频道的回填结果
 * @param channelName - 频道名称
 * @param messageCount - 回填的消息数量
 */
export function logBackfillChannel(channelName: string, messageCount: number): void {
	console.log(chalk.blue(`${timestamp()} [system]   #${channelName}: ${messageCount} messages`));
}

/**
 * 记录回填完成
 * @param totalMessages - 总回填消息数
 * @param durationMs - 回填耗时（毫秒）
 */
export function logBackfillComplete(totalMessages: number, durationMs: number): void {
	const duration = (durationMs / 1000).toFixed(1);
	console.log(chalk.blue(`${timestamp()} [system] Backfill complete: ${totalMessages} messages in ${duration}s`));
}
