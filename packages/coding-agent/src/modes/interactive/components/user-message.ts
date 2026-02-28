/**
 * 用户消息显示组件。
 *
 * 该文件提供用于在聊天界面中渲染用户输入消息的组件，
 * 支持 Markdown 格式，并使用主题配色显示用户消息背景和文字。
 */

import { Container, Markdown, type MarkdownTheme, Spacer } from "@mariozechner/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.js";

/**
 * 用户消息渲染组件。
 * 将用户消息以 Markdown 格式渲染，带有用户消息专属的背景色和文字颜色。
 */
export class UserMessageComponent extends Container {
	constructor(text: string, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super();
		this.addChild(new Spacer(1));
		this.addChild(
			new Markdown(text, 1, 1, markdownTheme, {
				bgColor: (text: string) => theme.bg("userMessageBg", text),
				color: (text: string) => theme.fg("userMessageText", text),
			}),
		);
	}
}
