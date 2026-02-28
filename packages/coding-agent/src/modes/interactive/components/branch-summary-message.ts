/**
 * 分支摘要消息组件。
 *
 * 该文件提供分支操作摘要的显示组件，支持折叠/展开两种状态，
 * 用于在会话分支操作后展示分支摘要信息。
 */

import { Box, Markdown, type MarkdownTheme, Spacer, Text } from "@mariozechner/pi-tui";
import type { BranchSummaryMessage } from "../../../core/messages.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { editorKey } from "./keybinding-hints.js";

/**
 * 分支摘要消息渲染组件。
 * 使用与自定义消息相同的背景色以保持视觉一致性。
 * 折叠时显示简要提示，展开时以 Markdown 格式显示完整摘要。
 */
export class BranchSummaryMessageComponent extends Box {
	private expanded = false;
	private message: BranchSummaryMessage;
	private markdownTheme: MarkdownTheme;

	constructor(message: BranchSummaryMessage, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
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

		const label = theme.fg("customMessageLabel", `\x1b[1m[branch]\x1b[22m`);
		this.addChild(new Text(label, 0, 0));
		this.addChild(new Spacer(1));

		if (this.expanded) {
			const header = "**Branch Summary**\n\n";
			this.addChild(
				new Markdown(header + this.message.summary, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			this.addChild(
				new Text(
					theme.fg("customMessageText", "Branch summary (") +
						theme.fg("dim", editorKey("expandTools")) +
						theme.fg("customMessageText", " to expand)"),
					0,
					0,
				),
			);
		}
	}
}
