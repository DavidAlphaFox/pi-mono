/**
 * @file format.ts
 * @description 格式化工具函数集合。
 * 提供费用、模型价格、用量统计和 Token 数量的格式化功能。
 */

import { i18n } from "@mariozechner/mini-lit";
import type { Usage } from "@mariozechner/pi-ai";

/**
 * 将费用格式化为美元字符串，保留四位小数。
 * @param cost - 费用数值
 * @returns 格式化后的费用字符串，如 "$0.0046"
 */
export function formatCost(cost: number): string {
	return `$${cost.toFixed(4)}`;
}

/**
 * 格式化模型的输入/输出价格（每百万 Token）。
 * 根据数值大小自动调整精度：>=100 取整，>=10 保留1位，>=1 保留2位，<1 保留3位。
 * @param cost - 包含 input 和 output 字段的价格对象
 * @returns 格式化字符串，如 "$3/$15"；若免费则返回 "Free"
 */
export function formatModelCost(cost: any): string {
	if (!cost) return i18n("Free");
	const input = cost.input || 0;
	const output = cost.output || 0;
	if (input === 0 && output === 0) return i18n("Free");

	// 根据数值范围选择合适的精度格式化数字
	const formatNum = (num: number): string => {
		if (num >= 100) return num.toFixed(0);
		if (num >= 10) return num.toFixed(1).replace(/\.0$/, "");
		if (num >= 1) return num.toFixed(2).replace(/\.?0+$/, "");
		return num.toFixed(3).replace(/\.?0+$/, "");
	};

	return `$${formatNum(input)}/$${formatNum(output)}`;
}

/**
 * 格式化 LLM 用量信息为可读字符串。
 * 包含输入 Token（↑）、输出 Token（↓）、缓存读取（R）、缓存写入（W）和总费用。
 * @param usage - 用量统计对象
 * @returns 格式化后的用量字符串，如 "↑3.8k ↓375 $0.0046"
 */
export function formatUsage(usage: Usage) {
	if (!usage) return "";

	const parts = [];
	if (usage.input) parts.push(`↑${formatTokenCount(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokenCount(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokenCount(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokenCount(usage.cacheWrite)}`);
	if (usage.cost?.total) parts.push(formatCost(usage.cost.total));

	return parts.join(" ");
}

/**
 * 将 Token 数量格式化为简洁的字符串。
 * 小于 1000 显示原始数字，1000-9999 显示如 "3.8k"，10000+ 显示如 "15k"。
 * @param count - Token 数量
 * @returns 格式化后的字符串
 */
export function formatTokenCount(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	return `${Math.round(count / 1000)}k`;
}
