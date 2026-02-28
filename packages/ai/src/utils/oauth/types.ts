/**
 * @file OAuth 类型定义
 *
 * 本文件定义了 OAuth 认证流程中使用的所有类型，包括：
 * - OAuthCredentials：存储访问令牌、刷新令牌和过期时间
 * - OAuthLoginCallbacks：登录流程的回调接口（URL 展示、用户输入、进度报告）
 * - OAuthProviderInterface：OAuth 提供商的统一接口（登录、刷新、获取密钥）
 */

import type { Api, Model } from "../../types.js";

/** OAuth 凭据，包含刷新令牌、访问令牌和过期时间戳 */
export type OAuthCredentials = {
	refresh: string;
	access: string;
	expires: number;
	[key: string]: unknown;
};

/** OAuth 提供商标识符类型 */
export type OAuthProviderId = string;

/** @deprecated Use OAuthProviderId instead */
export type OAuthProvider = OAuthProviderId;

/** OAuth 用户输入提示信息 */
export type OAuthPrompt = {
	message: string;
	placeholder?: string;
	allowEmpty?: boolean;
};

/** OAuth 授权 URL 信息 */
export type OAuthAuthInfo = {
	url: string;
	instructions?: string;
};

/** OAuth 登录流程的回调接口 */
export interface OAuthLoginCallbacks {
	onAuth: (info: OAuthAuthInfo) => void;
	onPrompt: (prompt: OAuthPrompt) => Promise<string>;
	onProgress?: (message: string) => void;
	onManualCodeInput?: () => Promise<string>;
	signal?: AbortSignal;
}

/** OAuth 提供商的统一接口，定义登录、令牌刷新和密钥获取等能力 */
export interface OAuthProviderInterface {
	readonly id: OAuthProviderId;
	readonly name: string;

	/** Run the login flow, return credentials to persist */
	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;

	/** Whether login uses a local callback server and supports manual code input. */
	usesCallbackServer?: boolean;

	/** Refresh expired credentials, return updated credentials to persist */
	refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;

	/** Convert credentials to API key string for the provider */
	getApiKey(credentials: OAuthCredentials): string;

	/** Optional: modify models for this provider (e.g., update baseUrl) */
	modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
}

/** @deprecated Use OAuthProviderInterface instead */
export interface OAuthProviderInfo {
	id: OAuthProviderId;
	name: string;
	available: boolean;
}
