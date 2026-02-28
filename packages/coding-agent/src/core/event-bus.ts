/**
 * 事件总线模块 - 模块间通信的简单事件发射器
 *
 * 职责：
 * - 提供发布/订阅机制用于模块间解耦通信
 * - 自动捕获事件处理器中的异常，避免崩溃
 * - 返回取消订阅函数便于清理
 */

import { EventEmitter } from "node:events";

/** 事件总线接口 - 发布和订阅事件 */
export interface EventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

/** 事件总线控制器 - 扩展 EventBus 增加清理功能 */
export interface EventBusController extends EventBus {
	clear(): void;
}

/** 创建事件总线实例 */
export function createEventBus(): EventBusController {
	const emitter = new EventEmitter();
	return {
		emit: (channel, data) => {
			emitter.emit(channel, data);
		},
		on: (channel, handler) => {
			const safeHandler = async (data: unknown) => {
				try {
					await handler(data);
				} catch (err) {
					console.error(`Event handler error (${channel}):`, err);
				}
			};
			emitter.on(channel, safeHandler);
			return () => emitter.off(channel, safeHandler);
		},
		clear: () => {
			emitter.removeAllListeners();
		},
	};
}
