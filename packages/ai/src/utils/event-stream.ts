/**
 * @file 通用异步事件流
 *
 * 本文件实现了一个基于生产者-消费者模式的异步事件流：
 * - EventStream：通用事件流基类，支持 push/end 生产和 for-await-of 消费
 * - AssistantMessageEventStream：专用于 AI 助手消息的事件流子类
 * - createAssistantMessageEventStream()：工厂函数，供扩展使用
 *
 * 核心特性：
 * - 背压控制：消费者跟不上时事件排队，消费者等待时直接投递
 * - 完成检测：通过 isComplete 回调自动识别流结束事件
 * - 结果提取：通过 result() 获取最终结果的 Promise
 */

import type { AssistantMessage, AssistantMessageEvent } from "../types.js";

/**
 * 通用异步事件流类，支持 push 生产和 async iteration 消费。
 * @template T 事件类型
 * @template R 最终结果类型
 */
export class EventStream<T, R = T> implements AsyncIterable<T> {
	/** 待消费的事件队列 */
	private queue: T[] = [];
	/** 等待事件的消费者回调列表 */
	private waiting: ((value: IteratorResult<T>) => void)[] = [];
	/** 流是否已结束 */
	private done = false;
	/** 最终结果的 Promise */
	private finalResultPromise: Promise<R>;
	/** 最终结果的 resolve 回调 */
	private resolveFinalResult!: (result: R) => void;

	constructor(
		private isComplete: (event: T) => boolean,
		private extractResult: (event: T) => R,
	) {
		this.finalResultPromise = new Promise((resolve) => {
			this.resolveFinalResult = resolve;
		});
	}

	/** 向流中推送一个事件，如果是完成事件则自动提取最终结果 */
	push(event: T): void {
		if (this.done) return;

		if (this.isComplete(event)) {
			this.done = true;
			this.resolveFinalResult(this.extractResult(event));
		}

		// Deliver to waiting consumer or queue it
		const waiter = this.waiting.shift();
		if (waiter) {
			waiter({ value: event, done: false });
		} else {
			this.queue.push(event);
		}
	}

	/** 结束流，通知所有等待的消费者 */
	end(result?: R): void {
		this.done = true;
		if (result !== undefined) {
			this.resolveFinalResult(result);
		}
		// Notify all waiting consumers that we're done
		while (this.waiting.length > 0) {
			const waiter = this.waiting.shift()!;
			waiter({ value: undefined as any, done: true });
		}
	}

	/** 异步迭代器实现，支持 for-await-of 语法消费事件 */
	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.queue.length > 0) {
				yield this.queue.shift()!;
			} else if (this.done) {
				return;
			} else {
				const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
				if (result.done) return;
				yield result.value;
			}
		}
	}

	/** 获取流的最终结果，在流完成后 resolve */
	result(): Promise<R> {
		return this.finalResultPromise;
	}
}

/** AI 助手消息专用事件流，在 done 或 error 事件时自动提取最终消息 */
export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") {
					return event.message;
				} else if (event.type === "error") {
					return event.error;
				}
				throw new Error("Unexpected event type for final result");
			},
		);
	}
}

/** Factory function for AssistantMessageEventStream (for use in extensions) */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}
