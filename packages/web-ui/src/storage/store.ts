/**
 * @file store.ts
 * @description 存储 Store 抽象基类。
 * 所有具体 Store（SettingsStore、SessionsStore 等）的基类，
 * 定义了 IndexedDB Schema 配置和后端访问的统一接口。
 */

import type { StorageBackend, StoreConfig } from "./types.js";

/**
 * Store 抽象基类。
 * 每个 Store 定义其 IndexedDB 架构（store 名称、键路径、索引），
 * 并通过 getBackend() 访问存储后端。
 */
export abstract class Store {
	private backend: StorageBackend | null = null;

	/**
	 * Returns the IndexedDB configuration for this store.
	 * Defines store name, key path, and indices.
	 */
	abstract getConfig(): StoreConfig;

	/**
	 * Sets the storage backend. Called by AppStorage after backend creation.
	 */
	setBackend(backend: StorageBackend): void {
		this.backend = backend;
	}

	/**
	 * Gets the storage backend. Throws if backend not set.
	 * Concrete stores must use this to access the backend.
	 */
	protected getBackend(): StorageBackend {
		if (!this.backend) {
			throw new Error(`Backend not set on ${this.constructor.name}`);
		}
		return this.backend;
	}
}
