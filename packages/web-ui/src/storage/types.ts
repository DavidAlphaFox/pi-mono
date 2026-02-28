/**
 * @file storage/types.ts
 * @description 存储层类型定义。
 * 定义 StorageBackend（存储后端抽象）、StorageTransaction（事务接口）、
 * SessionMetadata/SessionData（会话数据结构）、IndexedDB 配置等核心类型。
 */

import type { AgentMessage, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";

/**
 * 事务接口，用于跨 Store 的原子操作。
 */
export interface StorageTransaction {
	/**
	 * Get a value by key from a specific store.
	 */
	get<T = unknown>(storeName: string, key: string): Promise<T | null>;

	/**
	 * Set a value for a key in a specific store.
	 */
	set<T = unknown>(storeName: string, key: string, value: T): Promise<void>;

	/**
	 * Delete a key from a specific store.
	 */
	delete(storeName: string, key: string): Promise<void>;
}

/**
 * 存储后端基础接口。
 * 多 Store 键值存储抽象，可由 IndexedDB、远程 API 或其他多集合存储系统实现。
 */
export interface StorageBackend {
	/**
	 * Get a value by key from a specific store. Returns null if key doesn't exist.
	 */
	get<T = unknown>(storeName: string, key: string): Promise<T | null>;

	/**
	 * Set a value for a key in a specific store.
	 */
	set<T = unknown>(storeName: string, key: string, value: T): Promise<void>;

	/**
	 * Delete a key from a specific store.
	 */
	delete(storeName: string, key: string): Promise<void>;

	/**
	 * Get all keys from a specific store, optionally filtered by prefix.
	 */
	keys(storeName: string, prefix?: string): Promise<string[]>;

	/**
	 * Get all values from a specific store, ordered by an index.
	 * @param storeName - The store to query
	 * @param indexName - The index to use for ordering
	 * @param direction - Sort direction ("asc" or "desc")
	 */
	getAllFromIndex<T = unknown>(storeName: string, indexName: string, direction?: "asc" | "desc"): Promise<T[]>;

	/**
	 * Clear all data from a specific store.
	 */
	clear(storeName: string): Promise<void>;

	/**
	 * Check if a key exists in a specific store.
	 */
	has(storeName: string, key: string): Promise<boolean>;

	/**
	 * Execute atomic operations across multiple stores.
	 */
	transaction<T>(
		storeNames: string[],
		mode: "readonly" | "readwrite",
		operation: (tx: StorageTransaction) => Promise<T>,
	): Promise<T>;

	/**
	 * Get storage quota information.
	 * Used for warning users when approaching limits.
	 */
	getQuotaInfo(): Promise<{ usage: number; quota: number; percent: number }>;

	/**
	 * Request persistent storage (prevents eviction).
	 * Returns true if granted, false otherwise.
	 */
	requestPersistence(): Promise<boolean>;
}

/**
 * 轻量级会话元数据，用于列表展示和搜索。
 * 与完整会话数据分开存储，提升性能。
 */
export interface SessionMetadata {
	/** Unique session identifier (UUID v4) */
	id: string;

	/** User-defined title or auto-generated from first message */
	title: string;

	/** ISO 8601 UTC timestamp of creation */
	createdAt: string;

	/** ISO 8601 UTC timestamp of last modification */
	lastModified: string;

	/** Total number of messages (user + assistant + tool results) */
	messageCount: number;

	/** Cumulative usage statistics */
	usage: {
		/** Total input tokens */
		input: number;
		/** Total output tokens */
		output: number;
		/** Total cache read tokens */
		cacheRead: number;
		/** Total cache write tokens */
		cacheWrite: number;
		/** Total tokens processed */
		totalTokens: number;
		/** Total cost breakdown */
		cost: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			total: number;
		};
	};

	/** Last used thinking level */
	thinkingLevel: ThinkingLevel;

	/**
	 * Preview text for search and display.
	 * First 2KB of conversation text (user + assistant messages in sequence).
	 * Tool calls and tool results are excluded.
	 */
	preview: string;
}

/**
 * 完整会话数据，包含所有消息。
 * 仅在用户打开特定会话时加载。
 */
export interface SessionData {
	/** Unique session identifier (UUID v4) */
	id: string;

	/** User-defined title or auto-generated from first message */
	title: string;

	/** Last selected model */
	model: Model<any>;

	/** Last selected thinking level */
	thinkingLevel: ThinkingLevel;

	/** Full conversation history (with attachments inline) */
	messages: AgentMessage[];

	/** ISO 8601 UTC timestamp of creation */
	createdAt: string;

	/** ISO 8601 UTC timestamp of last modification */
	lastModified: string;
}

/**
 * IndexedDB 后端配置。
 */
export interface IndexedDBConfig {
	/** Database name */
	dbName: string;
	/** Database version */
	version: number;
	/** Object stores to create */
	stores: StoreConfig[];
}

/**
 * IndexedDB Object Store 配置。
 */
export interface StoreConfig {
	/** Store name */
	name: string;
	/** Key path (optional, for auto-extracting keys from objects) */
	keyPath?: string;
	/** Auto-increment keys (optional) */
	autoIncrement?: boolean;
	/** Indices to create on this store */
	indices?: IndexConfig[];
}

/**
 * IndexedDB 索引配置。
 */
export interface IndexConfig {
	/** Index name */
	name: string;
	/** Key path to index on */
	keyPath: string;
	/** Unique constraint (optional) */
	unique?: boolean;
}
