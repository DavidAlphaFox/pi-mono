/**
 * @file auth-token.ts
 * @description 认证令牌管理工具。
 * 负责从 localStorage 获取、存储和清除认证令牌（auth token）。
 * 若本地未存储令牌，会弹出对话框提示用户输入。
 */

import PromptDialog from "@mariozechner/mini-lit/dist/PromptDialog.js";
import { i18n } from "./i18n.js";

/**
 * 获取认证令牌。
 * 优先从 localStorage 读取；若不存在则循环弹出输入对话框直到用户提供有效令牌。
 * @returns 认证令牌字符串，或 undefined（不应出现）
 */
export async function getAuthToken(): Promise<string | undefined> {
	let authToken: string | undefined = localStorage.getItem(`auth-token`) || "";
	if (authToken) return authToken;

	while (true) {
		authToken = (
			await PromptDialog.ask(i18n("Enter Auth Token"), i18n("Please enter your auth token."), "", true)
		)?.trim();
		if (authToken) {
			localStorage.setItem(`auth-token`, authToken);
			break;
		}
	}
	return authToken?.trim() || undefined;
}

/**
 * 清除已保存的认证令牌。
 * 从 localStorage 中移除 auth-token 条目。
 */
export async function clearAuthToken() {
	localStorage.removeItem(`auth-token`);
}
