/**
 * @file custom-providers-store.ts
 * @description 自定义 LLM 提供商 Store。
 * 管理用户添加的自定义提供商配置（本地服务器和远程 API），
 * 区分自动发现类型（运行时获取模型）和手动配置类型（模型存储在 provider 对象中）。
 */

import type { Model } from "@mariozechner/pi-ai";
import { Store } from "../store.js";
import type { StoreConfig } from "../types.js";

/** 支持自动发现的提供商类型 */
export type AutoDiscoveryProviderType = "ollama" | "llama.cpp" | "vllm" | "lmstudio";

/** 自定义提供商类型（包括自动发现和手动配置） */
export type CustomProviderType =
	| AutoDiscoveryProviderType // 自动发现 - 模型按需获取
	| "openai-completions" // 手动配置 - 模型存储在 provider.models 中
	| "openai-responses" // 手动配置 - 模型存储在 provider.models 中
	| "anthropic-messages"; // 手动配置 - 模型存储在 provider.models 中

/** 自定义提供商配置接口 */
export interface CustomProvider {
	id: string; // UUID
	name: string; // Display name, also used as Model.provider
	type: CustomProviderType;
	baseUrl: string;
	apiKey?: string; // Optional, applies to all models

	// For manual types ONLY - models stored directly on provider
	// Auto-discovery types: models fetched on-demand, never stored
	models?: Model<any>[];
}

/**
 * 自定义 LLM 提供商 Store。
 * 提供 CRUD 操作和订阅变更通知功能。
 */
export class CustomProvidersStore extends Store {
	getConfig(): StoreConfig {
		return {
			name: "custom-providers",
		};
	}

	async get(id: string): Promise<CustomProvider | null> {
		return this.getBackend().get("custom-providers", id);
	}

	async set(provider: CustomProvider): Promise<void> {
		await this.getBackend().set("custom-providers", provider.id, provider);
	}

	async delete(id: string): Promise<void> {
		await this.getBackend().delete("custom-providers", id);
	}

	async getAll(): Promise<CustomProvider[]> {
		const keys = await this.getBackend().keys("custom-providers");
		const providers: CustomProvider[] = [];
		for (const key of keys) {
			const provider = await this.get(key);
			if (provider) {
				providers.push(provider);
			}
		}
		return providers;
	}

	async has(id: string): Promise<boolean> {
		return this.getBackend().has("custom-providers", id);
	}
}
