/**
 * @file MessageList.ts
 * @description 消息列表组件（<message-list>）。
 * 渲染稳定的（非流式）消息列表，使用 Lit 的 repeat 指令实现高效的 DOM 更新。
 * 支持用户消息、助手消息、工具消息的分类渲染和自定义消息渲染器。
 */

import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import type {
	AssistantMessage as AssistantMessageType,
	ToolResultMessage as ToolResultMessageType,
} from "@mariozechner/pi-ai";
import { html, LitElement, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { renderMessage } from "./message-renderer-registry.js";

/**
 * 消息列表 Web Component。
 * 接收消息数组，按角色分类渲染为对应的消息组件，
 * 跳过制品消息（artifact），优先使用自定义渲染器。
 */
export class MessageList extends LitElement {
	@property({ type: Array }) messages: AgentMessage[] = [];
	@property({ type: Array }) tools: AgentTool[] = [];
	@property({ type: Object }) pendingToolCalls?: Set<string>;
	@property({ type: Boolean }) isStreaming: boolean = false;
	@property({ attribute: false }) onCostClick?: () => void;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
	}

	/**
	 * 构建渲染项列表。
	 * 将消息数组转换为带唯一键和模板的渲染项，用于 repeat 指令。
	 */
	private buildRenderItems() {
		// 按工具调用 ID 建立工具结果索引，便于快速查找
		const resultByCallId = new Map<string, ToolResultMessageType>();
		for (const message of this.messages) {
			if (message.role === "toolResult") {
				resultByCallId.set(message.toolCallId, message);
			}
		}

		const items: Array<{ key: string; template: TemplateResult }> = [];
		let index = 0;
		for (const msg of this.messages) {
			// Skip artifact messages - they're for session persistence only, not UI display
			if (msg.role === "artifact") {
				continue;
			}

			// Try custom renderer first
			const customTemplate = renderMessage(msg);
			if (customTemplate) {
				items.push({ key: `msg:${index}`, template: customTemplate });
				index++;
				continue;
			}

			// Fall back to built-in renderers
			if (msg.role === "user" || msg.role === "user-with-attachments") {
				items.push({
					key: `msg:${index}`,
					template: html`<user-message .message=${msg}></user-message>`,
				});
				index++;
			} else if (msg.role === "assistant") {
				const amsg = msg as AssistantMessageType;
				items.push({
					key: `msg:${index}`,
					template: html`<assistant-message
						.message=${amsg}
						.tools=${this.tools}
						.isStreaming=${false}
						.pendingToolCalls=${this.pendingToolCalls}
						.toolResultsById=${resultByCallId}
						.hideToolCalls=${false}
						.hidePendingToolCalls=${this.isStreaming}
						.onCostClick=${this.onCostClick}
					></assistant-message>`,
				});
				index++;
			} else {
				// Skip standalone toolResult messages; they are rendered via paired tool-message above
				// Skip unknown roles
			}
		}
		return items;
	}

	override render() {
		const items = this.buildRenderItems();
		return html`<div class="flex flex-col gap-3">
			${repeat(
				items,
				(it) => it.key,
				(it) => it.template,
			)}
		</div>`;
	}
}

// Register custom element
if (!customElements.get("message-list")) {
	customElements.define("message-list", MessageList);
}
