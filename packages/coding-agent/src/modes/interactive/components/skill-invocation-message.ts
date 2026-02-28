/**
 * 技能调用消息组件。
 *
 * 该文件提供技能（Skill）调用信息的显示组件，支持折叠/展开。
 * 仅渲染技能块本身，用户消息由其他组件单独渲染。
 */

import { Box, Markdown, type MarkdownTheme, Text } from "@mariozechner/pi-tui";
import type { ParsedSkillBlock } from "../../../core/agent-session.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { editorKey } from "./keybinding-hints.js";

/**
 * 技能调用消息渲染组件。
 * 使用与自定义消息相同的背景色以保持视觉一致性。
 * 折叠时显示技能名称和展开提示，展开时以 Markdown 格式显示技能的完整内容。
 */
export class SkillInvocationMessageComponent extends Box {
	private expanded = false;
	private skillBlock: ParsedSkillBlock;
	private markdownTheme: MarkdownTheme;

	constructor(skillBlock: ParsedSkillBlock, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super(1, 1, (t) => theme.bg("customMessageBg", t));
		this.skillBlock = skillBlock;
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

		if (this.expanded) {
			// Expanded: label + skill name header + full content
			const label = theme.fg("customMessageLabel", `\x1b[1m[skill]\x1b[22m`);
			this.addChild(new Text(label, 0, 0));
			const header = `**${this.skillBlock.name}**\n\n`;
			this.addChild(
				new Markdown(header + this.skillBlock.content, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			// Collapsed: single line - [skill] name (hint to expand)
			const line =
				theme.fg("customMessageLabel", `\x1b[1m[skill]\x1b[22m `) +
				theme.fg("customMessageText", this.skillBlock.name) +
				theme.fg("dim", ` (${editorKey("expandTools")} to expand)`);
			this.addChild(new Text(line, 0, 0));
		}
	}
}
