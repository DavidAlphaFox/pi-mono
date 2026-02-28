/**
 * @file sessions-store.ts
 * @description 聊天会话 Store。
 * 管理聊天会话的完整数据和元数据，使用两个 Object Store：
 * sessions（完整数据）和 sessions-metadata（轻量元数据），
 * 支持保存、加载、删除会话以及从 AgentState 提取元数据。
 */

import type { AgentState } from "@mariozechner/pi-agent-core";
import { Store } from "../store.js";
import type { SessionData, SessionMetadata, StoreConfig } from "../types.js";

/**
 * 聊天会话 Store。
 * 数据与元数据分离存储以优化列表查询性能。
 */
export class SessionsStore extends Store {
	getConfig(): StoreConfig {
		return {
			name: "sessions",
			keyPath: "id",
			indices: [{ name: "lastModified", keyPath: "lastModified" }],
		};
	}

	/**
	 * Additional config for sessions-metadata store.
	 * Must be included when creating the backend.
	 */
	static getMetadataConfig(): StoreConfig {
		return {
			name: "sessions-metadata",
			keyPath: "id",
			indices: [{ name: "lastModified", keyPath: "lastModified" }],
		};
	}

	async save(data: SessionData, metadata: SessionMetadata): Promise<void> {
		await this.getBackend().transaction(["sessions", "sessions-metadata"], "readwrite", async (tx) => {
			await tx.set("sessions", data.id, data);
			await tx.set("sessions-metadata", metadata.id, metadata);
		});
	}

	async get(id: string): Promise<SessionData | null> {
		return this.getBackend().get("sessions", id);
	}

	async getMetadata(id: string): Promise<SessionMetadata | null> {
		return this.getBackend().get("sessions-metadata", id);
	}

	async getAllMetadata(): Promise<SessionMetadata[]> {
		// Use the lastModified index to get sessions sorted by most recent first
		return this.getBackend().getAllFromIndex<SessionMetadata>("sessions-metadata", "lastModified", "desc");
	}

	async delete(id: string): Promise<void> {
		await this.getBackend().transaction(["sessions", "sessions-metadata"], "readwrite", async (tx) => {
			await tx.delete("sessions", id);
			await tx.delete("sessions-metadata", id);
		});
	}

	// Alias for backward compatibility
	async deleteSession(id: string): Promise<void> {
		return this.delete(id);
	}

	async updateTitle(id: string, title: string): Promise<void> {
		const metadata = await this.getMetadata(id);
		if (metadata) {
			metadata.title = title;
			await this.getBackend().set("sessions-metadata", id, metadata);
		}

		// Also update in full session data
		const data = await this.get(id);
		if (data) {
			data.title = title;
			await this.getBackend().set("sessions", id, data);
		}
	}

	async getQuotaInfo(): Promise<{ usage: number; quota: number; percent: number }> {
		return this.getBackend().getQuotaInfo();
	}

	async requestPersistence(): Promise<boolean> {
		return this.getBackend().requestPersistence();
	}

	// Alias methods for backward compatibility
	async saveSession(
		id: string,
		state: AgentState,
		metadata: SessionMetadata | undefined,
		title?: string,
	): Promise<void> {
		// If metadata is provided, use it; otherwise create it from state
		const meta: SessionMetadata = metadata || {
			id,
			title: title || "",
			createdAt: new Date().toISOString(),
			lastModified: new Date().toISOString(),
			messageCount: state.messages?.length || 0,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			thinkingLevel: state.thinkingLevel || "off",
			preview: "",
		};

		const data: SessionData = {
			id,
			title: title || meta.title,
			model: state.model,
			thinkingLevel: state.thinkingLevel,
			messages: state.messages || [],
			createdAt: meta.createdAt,
			lastModified: new Date().toISOString(),
		};

		await this.save(data, meta);
	}

	async loadSession(id: string): Promise<SessionData | null> {
		return this.get(id);
	}

	async getLatestSessionId(): Promise<string | null> {
		const allMetadata = await this.getAllMetadata();
		if (allMetadata.length === 0) return null;

		// Sort by lastModified descending
		allMetadata.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
		return allMetadata[0].id;
	}
}
