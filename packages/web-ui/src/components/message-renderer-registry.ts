/**
 * @file message-renderer-registry.ts
 * @description 消息渲染器注册表。
 * 提供按消息角色（role）注册和查找自定义消息渲染器的机制，
 * 允许扩展或替换内置的消息渲染逻辑。
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TemplateResult } from "lit";

/** 从 AgentMessage 联合类型中提取角色类型 */
export type MessageRole = AgentMessage["role"];

/** 通用消息渲染器接口，可泛型指定具体消息类型 */
export interface MessageRenderer<TMessage extends AgentMessage = AgentMessage> {
	render(message: TMessage): TemplateResult;
}

/** 按角色存储的自定义消息渲染器映射表 */
const messageRenderers = new Map<MessageRole, MessageRenderer<any>>();

/**
 * 注册一个自定义消息渲染器。
 * @param role - 消息角色
 * @param renderer - 对应的渲染器实例
 */
export function registerMessageRenderer<TRole extends MessageRole>(
	role: TRole,
	renderer: MessageRenderer<Extract<AgentMessage, { role: TRole }>>,
): void {
	messageRenderers.set(role, renderer);
}

/**
 * 获取指定角色的消息渲染器。
 * @param role - 消息角色
 * @returns 渲染器实例，若未注册则返回 undefined
 */
export function getMessageRenderer(role: MessageRole): MessageRenderer | undefined {
	return messageRenderers.get(role);
}

/**
 * 尝试使用自定义渲染器渲染消息。
 * @param message - 要渲染的消息
 * @returns 渲染结果模板，若无对应渲染器则返回 undefined
 */
export function renderMessage(message: AgentMessage): TemplateResult | undefined {
	return messageRenderers.get(message.role)?.render(message);
}
