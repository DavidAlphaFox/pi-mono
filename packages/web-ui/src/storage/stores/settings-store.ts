/**
 * @file settings-store.ts
 * @description 应用设置 Store。
 * 管理主题、代理配置等应用级设置，使用字符串键值对存储。
 * 支持变更订阅通知。
 */

import { Store } from "../store.js";
import type { StoreConfig } from "../types.js";

/**
 * 设置 Store。
 * 通用键值存储，用于保存应用设置（主题、代理 URL 等）。
 */
export class SettingsStore extends Store {
	getConfig(): StoreConfig {
		return {
			name: "settings",
			// No keyPath - uses out-of-line keys
		};
	}

	async get<T>(key: string): Promise<T | null> {
		return this.getBackend().get("settings", key);
	}

	async set<T>(key: string, value: T): Promise<void> {
		await this.getBackend().set("settings", key, value);
	}

	async delete(key: string): Promise<void> {
		await this.getBackend().delete("settings", key);
	}

	async list(): Promise<string[]> {
		return this.getBackend().keys("settings");
	}

	async clear(): Promise<void> {
		await this.getBackend().clear("settings");
	}
}
