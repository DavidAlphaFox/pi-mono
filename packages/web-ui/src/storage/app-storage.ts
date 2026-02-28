/**
 * @file app-storage.ts
 * @description 应用存储管理器。
 * 提供对所有存储操作的高级 API，聚合设置、API Key、会话和自定义提供商等 Store。
 * 通过全局单例模式管理 AppStorage 实例。
 */

import type { CustomProvidersStore } from "./stores/custom-providers-store.js";
import type { ProviderKeysStore } from "./stores/provider-keys-store.js";
import type { SessionsStore } from "./stores/sessions-store.js";
import type { SettingsStore } from "./stores/settings-store.js";
import type { StorageBackend } from "./types.js";

/**
 * 应用存储管理器。
 * 聚合所有 Store（settings、providerKeys、sessions、customProviders），
 * 提供存储配额查询和持久化权限请求功能。子类可扩展以添加自定义 Store。
 */
export class AppStorage {
	readonly backend: StorageBackend;
	readonly settings: SettingsStore;
	readonly providerKeys: ProviderKeysStore;
	readonly sessions: SessionsStore;
	readonly customProviders: CustomProvidersStore;

	constructor(
		settings: SettingsStore,
		providerKeys: ProviderKeysStore,
		sessions: SessionsStore,
		customProviders: CustomProvidersStore,
		backend: StorageBackend,
	) {
		this.settings = settings;
		this.providerKeys = providerKeys;
		this.sessions = sessions;
		this.customProviders = customProviders;
		this.backend = backend;
	}

	async getQuotaInfo(): Promise<{ usage: number; quota: number; percent: number }> {
		return this.backend.getQuotaInfo();
	}

	async requestPersistence(): Promise<boolean> {
		return this.backend.requestPersistence();
	}
}

// 全局实例管理
let globalAppStorage: AppStorage | null = null;

/**
 * 获取全局 AppStorage 实例。
 * 若未初始化则抛出错误。
 */
export function getAppStorage(): AppStorage {
	if (!globalAppStorage) {
		throw new Error("AppStorage not initialized. Call setAppStorage() first.");
	}
	return globalAppStorage;
}

/**
 * 设置全局 AppStorage 实例。
 */
export function setAppStorage(storage: AppStorage): void {
	globalAppStorage = storage;
}
