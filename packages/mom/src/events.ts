/**
 * @file events.ts - 事件调度系统
 *
 * 本文件负责：
 * 1. 定义三种事件类型：即时事件（immediate）、一次性事件（one-shot）、周期性事件（periodic）
 * 2. 实现 EventsWatcher 类，监控 events/ 目录中的 JSON 事件文件
 * 3. 解析事件文件并根据类型进行调度：
 *    - 即时事件：立即触发
 *    - 一次性事件：在指定时间触发（使用 setTimeout）
 *    - 周期性事件：按 cron 表达式重复触发（使用 croner 库）
 * 4. 管理事件文件的生命周期（创建、修改、删除）
 */

import { Cron } from "croner";
import { existsSync, type FSWatcher, mkdirSync, readdirSync, statSync, unlinkSync, watch } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import * as log from "./log.js";
import type { SlackBot, SlackEvent } from "./slack.js";

// ============================================================================
// Event Types
// ============================================================================

/**
 * 即时事件 - 文件出现后立即触发
 * 适用于脚本/Webhook 等外部事件通知
 */
export interface ImmediateEvent {
	type: "immediate";
	/** 目标频道 ID */
	channelId: string;
	/** 事件消息文本 */
	text: string;
}

/**
 * 一次性事件 - 在指定时间触发一次
 * 适用于定时提醒
 */
export interface OneShotEvent {
	type: "one-shot";
	/** 目标频道 ID */
	channelId: string;
	/** 事件消息文本 */
	text: string;
	/** 触发时间，ISO 8601 格式含时区偏移 */
	at: string;
}

/**
 * 周期性事件 - 按 cron 表达式重复触发
 * 适用于定期检查、例行任务
 */
export interface PeriodicEvent {
	type: "periodic";
	/** 目标频道 ID */
	channelId: string;
	/** 事件消息文本 */
	text: string;
	/** cron 表达式 */
	schedule: string;
	/** IANA 时区名称 */
	timezone: string;
}

/** 所有事件类型的联合类型 */
export type MomEvent = ImmediateEvent | OneShotEvent | PeriodicEvent;

// ============================================================================
// EventsWatcher
// ============================================================================

/** 文件变更防抖延迟（毫秒） */
const DEBOUNCE_MS = 100;
/** 文件解析最大重试次数 */
const MAX_RETRIES = 3;
/** 重试基础延迟（毫秒），按指数退避 */
const RETRY_BASE_MS = 100;

/**
 * 事件监视器类
 * 监控 events/ 目录中的 JSON 文件变化，解析事件并调度执行
 */
export class EventsWatcher {
	/** 一次性事件的定时器映射（文件名 -> 定时器） */
	private timers: Map<string, NodeJS.Timeout> = new Map();
	/** 周期性事件的 cron 任务映射（文件名 -> Cron 实例） */
	private crons: Map<string, Cron> = new Map();
	/** 文件变更防抖定时器映射 */
	private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
	/** 监视器启动时间，用于判断即时事件是否过期 */
	private startTime: number;
	/** 文件系统监视器 */
	private watcher: FSWatcher | null = null;
	/** 已知的事件文件集合 */
	private knownFiles: Set<string> = new Set();

	/**
	 * @param eventsDir - 事件文件目录路径
	 * @param slack - SlackBot 实例，用于将事件入队处理
	 */
	constructor(
		private eventsDir: string,
		private slack: SlackBot,
	) {
		this.startTime = Date.now();
	}

	/**
	 * 启动事件监视
	 * 扫描已有的事件文件并开始监听新的文件变化。
	 * 应在 SlackBot 就绪后调用。
	 */
	start(): void {
		// 确保事件目录存在
		if (!existsSync(this.eventsDir)) {
			mkdirSync(this.eventsDir, { recursive: true });
		}

		log.logInfo(`Events watcher starting, dir: ${this.eventsDir}`);

		// 扫描已有的事件文件
		this.scanExisting();

		// 监听文件变化
		this.watcher = watch(this.eventsDir, (_eventType, filename) => {
			if (!filename || !filename.endsWith(".json")) return;
			this.debounce(filename, () => this.handleFileChange(filename));
		});

		log.logInfo(`Events watcher started, tracking ${this.knownFiles.size} files`);
	}

	/**
	 * 停止监视并取消所有已调度的事件
	 */
	stop(): void {
		// 停止文件系统监视器
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}

		// 取消所有防抖定时器
		for (const timer of this.debounceTimers.values()) {
			clearTimeout(timer);
		}
		this.debounceTimers.clear();

		// 取消所有一次性事件定时器
		for (const timer of this.timers.values()) {
			clearTimeout(timer);
		}
		this.timers.clear();

		// 取消所有周期性 cron 任务
		for (const cron of this.crons.values()) {
			cron.stop();
		}
		this.crons.clear();

		this.knownFiles.clear();
		log.logInfo("Events watcher stopped");
	}

	/**
	 * 对文件变更事件进行防抖处理
	 * 在文件快速连续变化时，只处理最后一次变更
	 * @param filename - 文件名
	 * @param fn - 要执行的函数
	 */
	private debounce(filename: string, fn: () => void): void {
		const existing = this.debounceTimers.get(filename);
		if (existing) {
			clearTimeout(existing);
		}
		this.debounceTimers.set(
			filename,
			setTimeout(() => {
				this.debounceTimers.delete(filename);
				fn();
			}, DEBOUNCE_MS),
		);
	}

	/**
	 * 扫描事件目录中已有的 JSON 文件
	 */
	private scanExisting(): void {
		let files: string[];
		try {
			files = readdirSync(this.eventsDir).filter((f) => f.endsWith(".json"));
		} catch (err) {
			log.logWarning("Failed to read events directory", String(err));
			return;
		}

		for (const filename of files) {
			this.handleFile(filename);
		}
	}

	/**
	 * 处理文件变更事件
	 * 根据文件状态（新建/修改/删除）执行相应操作
	 * @param filename - 变更的文件名
	 */
	private handleFileChange(filename: string): void {
		const filePath = join(this.eventsDir, filename);

		if (!existsSync(filePath)) {
			// 文件被删除
			this.handleDelete(filename);
		} else if (this.knownFiles.has(filename)) {
			// 文件被修改 - 取消已有调度并重新调度
			this.cancelScheduled(filename);
			this.handleFile(filename);
		} else {
			// 新文件
			this.handleFile(filename);
		}
	}

	/**
	 * 处理事件文件删除
	 * @param filename - 被删除的文件名
	 */
	private handleDelete(filename: string): void {
		if (!this.knownFiles.has(filename)) return;

		log.logInfo(`Event file deleted: ${filename}`);
		this.cancelScheduled(filename);
		this.knownFiles.delete(filename);
	}

	/**
	 * 取消已调度的事件（定时器或 cron 任务）
	 * @param filename - 事件文件名
	 */
	private cancelScheduled(filename: string): void {
		const timer = this.timers.get(filename);
		if (timer) {
			clearTimeout(timer);
			this.timers.delete(filename);
		}

		const cron = this.crons.get(filename);
		if (cron) {
			cron.stop();
			this.crons.delete(filename);
		}
	}

	/**
	 * 解析并处理事件文件
	 * 支持重试机制，解析失败后按指数退避重试
	 * @param filename - 事件文件名
	 */
	private async handleFile(filename: string): Promise<void> {
		const filePath = join(this.eventsDir, filename);

		// 带重试的文件解析
		let event: MomEvent | null = null;
		let lastError: Error | null = null;

		for (let i = 0; i < MAX_RETRIES; i++) {
			try {
				const content = await readFile(filePath, "utf-8");
				event = this.parseEvent(content, filename);
				break;
			} catch (err) {
				lastError = err instanceof Error ? err : new Error(String(err));
				if (i < MAX_RETRIES - 1) {
					// 指数退避等待
					await this.sleep(RETRY_BASE_MS * 2 ** i);
				}
			}
		}

		if (!event) {
			log.logWarning(`Failed to parse event file after ${MAX_RETRIES} retries: ${filename}`, lastError?.message);
			this.deleteFile(filename);
			return;
		}

		this.knownFiles.add(filename);

		// 根据事件类型调度执行
		switch (event.type) {
			case "immediate":
				this.handleImmediate(filename, event);
				break;
			case "one-shot":
				this.handleOneShot(filename, event);
				break;
			case "periodic":
				this.handlePeriodic(filename, event);
				break;
		}
	}

	/**
	 * 解析事件文件内容为事件对象
	 * @param content - 文件内容（JSON 字符串）
	 * @param filename - 文件名（用于错误消息）
	 * @returns 解析后的事件对象
	 * @throws 缺少必要字段或未知类型时抛出错误
	 */
	private parseEvent(content: string, filename: string): MomEvent | null {
		const data = JSON.parse(content);

		if (!data.type || !data.channelId || !data.text) {
			throw new Error(`Missing required fields (type, channelId, text) in ${filename}`);
		}

		switch (data.type) {
			case "immediate":
				return { type: "immediate", channelId: data.channelId, text: data.text };

			case "one-shot":
				if (!data.at) {
					throw new Error(`Missing 'at' field for one-shot event in ${filename}`);
				}
				return { type: "one-shot", channelId: data.channelId, text: data.text, at: data.at };

			case "periodic":
				if (!data.schedule) {
					throw new Error(`Missing 'schedule' field for periodic event in ${filename}`);
				}
				if (!data.timezone) {
					throw new Error(`Missing 'timezone' field for periodic event in ${filename}`);
				}
				return {
					type: "periodic",
					channelId: data.channelId,
					text: data.text,
					schedule: data.schedule,
					timezone: data.timezone,
				};

			default:
				throw new Error(`Unknown event type '${data.type}' in ${filename}`);
		}
	}

	/**
	 * 处理即时事件
	 * 检查是否过期（创建时间早于监视器启动时间），非过期则立即执行
	 * @param filename - 事件文件名
	 * @param event - 即时事件对象
	 */
	private handleImmediate(filename: string, event: ImmediateEvent): void {
		const filePath = join(this.eventsDir, filename);

		// 检查是否为过期事件（在监视器启动之前创建的）
		try {
			const stat = statSync(filePath);
			if (stat.mtimeMs < this.startTime) {
				log.logInfo(`Stale immediate event, deleting: ${filename}`);
				this.deleteFile(filename);
				return;
			}
		} catch {
			// 文件可能已被删除
			return;
		}

		log.logInfo(`Executing immediate event: ${filename}`);
		this.execute(filename, event);
	}

	/**
	 * 处理一次性事件
	 * 如果触发时间已过则直接删除，否则使用 setTimeout 调度
	 * @param filename - 事件文件名
	 * @param event - 一次性事件对象
	 */
	private handleOneShot(filename: string, event: OneShotEvent): void {
		const atTime = new Date(event.at).getTime();
		const now = Date.now();

		if (atTime <= now) {
			// 已过期 - 直接删除不执行
			log.logInfo(`One-shot event in the past, deleting: ${filename}`);
			this.deleteFile(filename);
			return;
		}

		const delay = atTime - now;
		log.logInfo(`Scheduling one-shot event: ${filename} in ${Math.round(delay / 1000)}s`);

		const timer = setTimeout(() => {
			this.timers.delete(filename);
			log.logInfo(`Executing one-shot event: ${filename}`);
			this.execute(filename, event);
		}, delay);

		this.timers.set(filename, timer);
	}

	/**
	 * 处理周期性事件
	 * 使用 croner 创建 cron 任务，按计划重复执行
	 * @param filename - 事件文件名
	 * @param event - 周期性事件对象
	 */
	private handlePeriodic(filename: string, event: PeriodicEvent): void {
		try {
			const cron = new Cron(event.schedule, { timezone: event.timezone }, () => {
				log.logInfo(`Executing periodic event: ${filename}`);
				this.execute(filename, event, false); // 周期性事件不删除文件
			});

			this.crons.set(filename, cron);

			const next = cron.nextRun();
			log.logInfo(`Scheduled periodic event: ${filename}, next run: ${next?.toISOString() ?? "unknown"}`);
		} catch (err) {
			log.logWarning(`Invalid cron schedule for ${filename}: ${event.schedule}`, String(err));
			this.deleteFile(filename);
		}
	}

	/**
	 * 执行事件：构造合成的 SlackEvent 并入队处理
	 * @param filename - 事件文件名
	 * @param event - 事件对象
	 * @param deleteAfter - 执行后是否删除文件（默认 true，周期性事件为 false）
	 */
	private execute(filename: string, event: MomEvent, deleteAfter: boolean = true): void {
		// 格式化事件消息，包含调度信息
		let scheduleInfo: string;
		switch (event.type) {
			case "immediate":
				scheduleInfo = "immediate";
				break;
			case "one-shot":
				scheduleInfo = event.at;
				break;
			case "periodic":
				scheduleInfo = event.schedule;
				break;
		}

		const message = `[EVENT:${filename}:${event.type}:${scheduleInfo}] ${event.text}`;

		// 创建合成的 SlackEvent
		const syntheticEvent: SlackEvent = {
			type: "mention",
			channel: event.channelId,
			user: "EVENT",
			text: message,
			ts: Date.now().toString(),
		};

		// 将事件入队处理
		const enqueued = this.slack.enqueueEvent(syntheticEvent);

		if (enqueued && deleteAfter) {
			// 入队成功后删除文件（即时和一次性事件）
			this.deleteFile(filename);
		} else if (!enqueued) {
			log.logWarning(`Event queue full, discarded: ${filename}`);
			// 即使丢弃也删除即时/一次性事件文件
			if (deleteAfter) {
				this.deleteFile(filename);
			}
		}
	}

	/**
	 * 删除事件文件
	 * @param filename - 要删除的文件名
	 */
	private deleteFile(filename: string): void {
		const filePath = join(this.eventsDir, filename);
		try {
			unlinkSync(filePath);
		} catch (err) {
			// ENOENT 是正常的（文件已被删除），其他错误记录警告
			if (err instanceof Error && "code" in err && err.code !== "ENOENT") {
				log.logWarning(`Failed to delete event file: ${filename}`, String(err));
			}
		}
		this.knownFiles.delete(filename);
	}

	/**
	 * 异步等待指定毫秒数
	 * @param ms - 等待毫秒数
	 */
	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}

/**
 * 创建事件监视器工厂函数
 * @param workspaceDir - 工作区目录路径
 * @param slack - SlackBot 实例
 * @returns EventsWatcher 实例
 */
export function createEventsWatcher(workspaceDir: string, slack: SlackBot): EventsWatcher {
	const eventsDir = join(workspaceDir, "events");
	return new EventsWatcher(eventsDir, slack);
}
