/**
 * @file Emacs 风格的 Kill Ring（剪切环）
 *
 * 实现环形缓冲区，用于 Emacs 风格的 kill/yank 操作。
 * 跟踪被删除（killed）的文本条目。连续的 kill 操作可以
 * 累积到同一条目中。支持 yank（粘贴最近条目）和 yank-pop
 * （循环浏览旧条目）。
 */

/**
 * Kill Ring 环形缓冲区。
 * 存储被删除的文本，支持 yank 粘贴和 yank-pop 循环。
 */
export class KillRing {
	/** 环形缓冲区数组，最新条目在末尾 */
	private ring: string[] = [];

	/**
	 * 将文本添加到 Kill Ring。
	 *
	 * @param text - 要添加的被删除文本
	 * @param opts - 推入选项
	 * @param opts.prepend - 累积时是前置（向后删除）还是追加（向前删除）
	 * @param opts.accumulate - 是否与最近的条目合并而非创建新条目
	 */
	push(text: string, opts: { prepend: boolean; accumulate?: boolean }): void {
		if (!text) return;

		if (opts.accumulate && this.ring.length > 0) {
			const last = this.ring.pop()!;
			this.ring.push(opts.prepend ? text + last : last + text);
		} else {
			this.ring.push(text);
		}
	}

	/** 获取最近的条目（不修改环） */
	peek(): string | undefined {
		return this.ring.length > 0 ? this.ring[this.ring.length - 1] : undefined;
	}

	/** 将最后一个条目移到前面（用于 yank-pop 循环） */
	rotate(): void {
		if (this.ring.length > 1) {
			const last = this.ring.pop()!;
			this.ring.unshift(last);
		}
	}

	/** 获取 Kill Ring 中的条目数量 */
	get length(): number {
		return this.ring.length;
	}
}
