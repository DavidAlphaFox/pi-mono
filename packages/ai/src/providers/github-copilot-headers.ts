/**
 * @file GitHub Copilot 请求头工具
 *
 * 本文件提供构建 GitHub Copilot API 请求所需的动态 HTTP 头的工具函数，包括：
 * - X-Initiator：标识请求是用户发起还是代理（工具调用后续）发起
 * - Copilot-Vision-Request：当消息包含图像时标记为视觉请求
 * - Openai-Intent：标识请求的意图类型
 */

import type { Message } from "../types.js";

/** 根据最后一条消息的角色推断 Copilot 请求的发起者类型 */
export function inferCopilotInitiator(messages: Message[]): "user" | "agent" {
	const last = messages[messages.length - 1];
	return last && last.role !== "user" ? "agent" : "user";
}

/** 检查消息中是否包含图像内容（用户消息或工具结果中的图像） */
export function hasCopilotVisionInput(messages: Message[]): boolean {
	return messages.some((msg) => {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			return msg.content.some((c) => c.type === "image");
		}
		if (msg.role === "toolResult" && Array.isArray(msg.content)) {
			return msg.content.some((c) => c.type === "image");
		}
		return false;
	});
}

/** 构建 Copilot API 请求所需的动态 HTTP 头 */
export function buildCopilotDynamicHeaders(params: {
	messages: Message[];
	hasImages: boolean;
}): Record<string, string> {
	const headers: Record<string, string> = {
		"X-Initiator": inferCopilotInitiator(params.messages),
		"Openai-Intent": "conversation-edits",
	};

	if (params.hasImages) {
		headers["Copilot-Vision-Request"] = "true";
	}

	return headers;
}
