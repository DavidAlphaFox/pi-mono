/**
 * @file 流式 JSON 解析器
 *
 * 本文件提供在流式传输过程中解析可能不完整的 JSON 字符串的工具。
 * 用于在工具调用参数流式传输期间，即使 JSON 尚未完整也能提取部分参数。
 */

import { parse as partialParse } from "partial-json";

/**
 * 尝试解析流式传输中可能不完整的 JSON。
 * 优先使用标准 JSON.parse（对完整 JSON 最快），失败则使用 partial-json 库。
 * 始终返回有效对象，即使 JSON 不完整或解析失败也返回空对象。
 *
 * @param partialJson 流式传输中的部分 JSON 字符串
 * @returns 解析后的对象，或解析失败时返回空对象
 */
export function parseStreamingJson<T = any>(partialJson: string | undefined): T {
	if (!partialJson || partialJson.trim() === "") {
		return {} as T;
	}

	// Try standard parsing first (fastest for complete JSON)
	try {
		return JSON.parse(partialJson) as T;
	} catch {
		// Try partial-json for incomplete JSON
		try {
			const result = partialParse(partialJson);
			return (result ?? {}) as T;
		} catch {
			// If all parsing fails, return empty object
			return {} as T;
		}
	}
}
