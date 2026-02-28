/**
 * 压缩摘要消息组件。
 *
 * 该文件提供上下文压缩操作摘要的显示组件，支持折叠/展开。
 * 显示压缩前的 token 数量和压缩后的摘要内容。
 */

import { Box, Markdown, type MarkdownTheme, Spacer, Text } from "@mariozechner/pi-tui";
import type { CompactionSummaryMessage } from "../../../core/messages.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { editorKey } from "./keybinding-hints.js";

/**
 * 压缩摘要消息渲染组件。
 * 使用与自定义消息相同的背景色以保持视觉一致性。
 * 折叠时显示 token 数量概览，展开时以 Markdown 格式显示完整摘要。
 */
export class CompactionSummaryMessageComponent extends Box {
	private expanded = false;
	private message: CompactionSummaryMessage;
	private markdownTheme: MarkdownTheme;

	constructor(message: CompactionSummaryMessage, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super(1, 1, (t) => theme.bg("customMessageBg", t));
		this.message = message;
		this.markdownTheme = markdownTheme;
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();

		const tokenStr = this.message.tokensBefore.toLocaleString();
		const label = theme.fg("customMessageLabel", `\x1b[1m[compaction]\x1b[22m`);
		this.addChild(new Text(label, 0, 0));
		this.addChild(new Spacer(1));

		if (this.expanded) {
			const header = `**Compacted from ${tokenStr} tokens**\n\n`;
			this.addChild(
				new Markdown(header + this.message.summary, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			this.addChild(
				new Text(
					theme.fg("customMessageText", `Compacted from ${tokenStr} tokens (`) +
						theme.fg("dim", editorKey("expandTools")) +
						theme.fg("customMessageText", " to expand)"),
					0,
					0,
				),
			);
		}
	}
}
