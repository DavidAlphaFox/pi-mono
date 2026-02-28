/**
 * @file OAuth 凭据管理入口
 *
 * 本文件是 OAuth 认证模块的主入口，负责：
 * - 提供商注册表管理（注册、注销、查询 OAuth 提供商）
 * - 统一的登录、令牌刷新接口
 * - 自动检测过期令牌并刷新
 *
 * 支持的 OAuth 提供商：
 * - Anthropic（Claude Pro/Max）
 * - GitHub Copilot（设备码流程）
 * - Google Cloud Code Assist / Gemini CLI
 * - Antigravity（Gemini 3、Claude、GPT-OSS via Google Cloud）
 * - OpenAI Codex（ChatGPT 订阅）
 */

// Set up HTTP proxy for fetch() calls (respects HTTP_PROXY, HTTPS_PROXY env vars)
import "../http-proxy.js";

// Anthropic
export { anthropicOAuthProvider, loginAnthropic, refreshAnthropicToken } from "./anthropic.js";
// GitHub Copilot
export {
	getGitHubCopilotBaseUrl,
	githubCopilotOAuthProvider,
	loginGitHubCopilot,
	normalizeDomain,
	refreshGitHubCopilotToken,
} from "./github-copilot.js";
// Google Antigravity
export { antigravityOAuthProvider, loginAntigravity, refreshAntigravityToken } from "./google-antigravity.js";
// Google Gemini CLI
export { geminiCliOAuthProvider, loginGeminiCli, refreshGoogleCloudToken } from "./google-gemini-cli.js";
// OpenAI Codex (ChatGPT OAuth)
export { loginOpenAICodex, openaiCodexOAuthProvider, refreshOpenAICodexToken } from "./openai-codex.js";

export * from "./types.js";

// ============================================================================
// Provider Registry
// ============================================================================

import { anthropicOAuthProvider } from "./anthropic.js";
import { githubCopilotOAuthProvider } from "./github-copilot.js";
import { antigravityOAuthProvider } from "./google-antigravity.js";
import { geminiCliOAuthProvider } from "./google-gemini-cli.js";
import { openaiCodexOAuthProvider } from "./openai-codex.js";
import type { OAuthCredentials, OAuthProviderId, OAuthProviderInfo, OAuthProviderInterface } from "./types.js";

/** 内置 OAuth 提供商列表 */
const BUILT_IN_OAUTH_PROVIDERS: OAuthProviderInterface[] = [
	anthropicOAuthProvider,
	githubCopilotOAuthProvider,
	geminiCliOAuthProvider,
	antigravityOAuthProvider,
	openaiCodexOAuthProvider,
];

/** OAuth 提供商注册表，以提供商 ID 为键 */
const oauthProviderRegistry = new Map<string, OAuthProviderInterface>(
	BUILT_IN_OAUTH_PROVIDERS.map((provider) => [provider.id, provider]),
);

/** 根据 ID 获取 OAuth 提供商 */
export function getOAuthProvider(id: OAuthProviderId): OAuthProviderInterface | undefined {
	return oauthProviderRegistry.get(id);
}

/** 注册自定义 OAuth 提供商 */
export function registerOAuthProvider(provider: OAuthProviderInterface): void {
	oauthProviderRegistry.set(provider.id, provider);
}

/** 注销 OAuth 提供商。内置提供商会恢复为默认实现，自定义提供商则完全移除 */
export function unregisterOAuthProvider(id: string): void {
	const builtInProvider = BUILT_IN_OAUTH_PROVIDERS.find((provider) => provider.id === id);
	if (builtInProvider) {
		oauthProviderRegistry.set(id, builtInProvider);
		return;
	}
	oauthProviderRegistry.delete(id);
}

/** 重置 OAuth 提供商注册表为内置默认状态 */
export function resetOAuthProviders(): void {
	oauthProviderRegistry.clear();
	for (const provider of BUILT_IN_OAUTH_PROVIDERS) {
		oauthProviderRegistry.set(provider.id, provider);
	}
}

/** 获取所有已注册的 OAuth 提供商 */
export function getOAuthProviders(): OAuthProviderInterface[] {
	return Array.from(oauthProviderRegistry.values());
}

/**
 * @deprecated Use getOAuthProviders() which returns OAuthProviderInterface[]
 */
export function getOAuthProviderInfoList(): OAuthProviderInfo[] {
	return getOAuthProviders().map((p) => ({
		id: p.id,
		name: p.name,
		available: true,
	}));
}

// ============================================================================
// High-level API (uses provider registry)
// ============================================================================

/**
 * 刷新任意 OAuth 提供商的令牌。
 * @deprecated 请使用 getOAuthProvider(id).refreshToken() 代替
 */
export async function refreshOAuthToken(
	providerId: OAuthProviderId,
	credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
	const provider = getOAuthProvider(providerId);
	if (!provider) {
		throw new Error(`Unknown OAuth provider: ${providerId}`);
	}
	return provider.refreshToken(credentials);
}

/**
 * 从 OAuth 凭据中获取提供商的 API 密钥。
 * 自动刷新已过期的令牌。
 *
 * @returns API 密钥字符串和更新后的凭据，无凭据时返回 null
 * @throws 刷新失败时抛出错误
 */
export async function getOAuthApiKey(
	providerId: OAuthProviderId,
	credentials: Record<string, OAuthCredentials>,
): Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null> {
	const provider = getOAuthProvider(providerId);
	if (!provider) {
		throw new Error(`Unknown OAuth provider: ${providerId}`);
	}

	let creds = credentials[providerId];
	if (!creds) {
		return null;
	}

	// Refresh if expired
	if (Date.now() >= creds.expires) {
		try {
			creds = await provider.refreshToken(creds);
		} catch (_error) {
			throw new Error(`Failed to refresh OAuth token for ${providerId}`);
		}
	}

	const apiKey = provider.getApiKey(creds);
	return { newCredentials: creds, apiKey };
}
