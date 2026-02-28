/**
 * @file 通用撤销栈
 *
 * 提供带有深拷贝语义的撤销栈实现。
 * 推入时自动深拷贝状态快照，弹出的快照直接返回
 * （无需再次拷贝，因为已经与原始状态分离）。
 */

/**
 * 通用撤销栈。
 * 使用 structuredClone 在推入时创建状态的深拷贝。
 * @template S - 状态快照的类型
 */
export class UndoStack<S> {
	/** 存储状态快照的栈 */
	private stack: S[] = [];

	/** 将给定状态的深拷贝推入栈中 */
	push(state: S): void {
		this.stack.push(structuredClone(state));
	}

	/** 弹出并返回最近的快照，栈为空时返回 undefined */
	pop(): S | undefined {
		return this.stack.pop();
	}

	/** 清除所有快照 */
	clear(): void {
		this.stack.length = 0;
	}

	/** 获取栈中的快照数量 */
	get length(): number {
		return this.stack.length;
	}
}
