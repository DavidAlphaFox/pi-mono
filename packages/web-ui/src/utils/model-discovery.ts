/**
 * @file model-discovery.ts
 * @description 本地 LLM 服务器模型发现工具。
 * 支持从 Ollama、llama.cpp、vLLM 和 LM Studio 服务器自动发现可用模型，
 * 并将其转换为统一的 Model 接口格式。
 */

import { LMStudioClient } from "@lmstudio/sdk";
import type { Model } from "@mariozechner/pi-ai";
import { Ollama } from "ollama/browser";

/**
 * 从 Ollama 服务器发现可用模型。
 * 使用 Ollama SDK 获取模型列表，过滤出支持工具调用的模型，
 * 并提取上下文窗口大小、推理能力等信息。
 * @param baseUrl - Ollama 服务器基础 URL（如 "http://localhost:11434"）
 * @param _apiKey - 可选 API Key（Ollama 当前未使用）
 * @returns 发现的模型数组
 */
export async function discoverOllamaModels(baseUrl: string, _apiKey?: string): Promise<Model<any>[]> {
	try {
		// Create Ollama client
		const ollama = new Ollama({ host: baseUrl });

		// Get list of available models
		const { models } = await ollama.list();

		// Fetch details for each model and convert to Model format
		const ollamaModelPromises: Promise<Model<any> | null>[] = models.map(async (model: any) => {
			try {
				// Get model details
				const details = await ollama.show({
					model: model.name,
				});

				// Check capabilities - filter out models that don't support tools
				const capabilities: string[] = (details as any).capabilities || [];
				if (!capabilities.includes("tools")) {
					console.debug(`Skipping model ${model.name}: does not support tools`);
					return null;
				}

				// Extract model info
				const modelInfo: any = details.model_info || {};

				// Get context window size - look for architecture-specific keys
				const architecture = modelInfo["general.architecture"] || "";
				const contextKey = `${architecture}.context_length`;
				const contextWindow = parseInt(modelInfo[contextKey] || "8192", 10);

				// Ollama caps max tokens at 10x context length
				const maxTokens = contextWindow * 10;

				// Ollama only supports completions API
				const ollamaModel: Model<any> = {
					id: model.name,
					name: model.name,
					api: "openai-completions" as any,
					provider: "", // Will be set by caller
					baseUrl: `${baseUrl}/v1`,
					reasoning: capabilities.includes("thinking"),
					input: ["text"],
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
					},
					contextWindow: contextWindow,
					maxTokens: maxTokens,
				};

				return ollamaModel;
			} catch (err) {
				console.error(`Failed to fetch details for model ${model.name}:`, err);
				return null;
			}
		});

		const results = await Promise.all(ollamaModelPromises);
		return results.filter((m): m is Model<any> => m !== null);
	} catch (err) {
		console.error("Failed to discover Ollama models:", err);
		throw new Error(`Ollama discovery failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/**
 * 从 llama.cpp 服务器发现可用模型。
 * 通过 OpenAI 兼容的 /v1/models 端点获取模型列表。
 * @param baseUrl - llama.cpp 服务器基础 URL（如 "http://localhost:8080"）
 * @param apiKey - 可选 API Key
 * @returns 发现的模型数组
 */
export async function discoverLlamaCppModels(baseUrl: string, apiKey?: string): Promise<Model<any>[]> {
	try {
		const headers: HeadersInit = {
			"Content-Type": "application/json",
		};

		if (apiKey) {
			headers.Authorization = `Bearer ${apiKey}`;
		}

		const response = await fetch(`${baseUrl}/v1/models`, {
			method: "GET",
			headers,
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		const data = await response.json();

		if (!data.data || !Array.isArray(data.data)) {
			throw new Error("Invalid response format from llama.cpp server");
		}

		return data.data.map((model: any) => {
			// llama.cpp doesn't always provide context window info
			const contextWindow = model.context_length || 8192;
			const maxTokens = model.max_tokens || 4096;

			const llamaModel: Model<any> = {
				id: model.id,
				name: model.id,
				api: "openai-completions" as any,
				provider: "", // Will be set by caller
				baseUrl: `${baseUrl}/v1`,
				reasoning: false,
				input: ["text"],
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
				},
				contextWindow: contextWindow,
				maxTokens: maxTokens,
			};

			return llamaModel;
		});
	} catch (err) {
		console.error("Failed to discover llama.cpp models:", err);
		throw new Error(`llama.cpp discovery failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/**
 * 从 vLLM 服务器发现可用模型。
 * 通过 OpenAI 兼容的 /v1/models 端点获取模型列表。
 * vLLM 提供 max_model_len 字段作为上下文窗口大小。
 * @param baseUrl - vLLM 服务器基础 URL（如 "http://localhost:8000"）
 * @param apiKey - 可选 API Key
 * @returns 发现的模型数组
 */
export async function discoverVLLMModels(baseUrl: string, apiKey?: string): Promise<Model<any>[]> {
	try {
		const headers: HeadersInit = {
			"Content-Type": "application/json",
		};

		if (apiKey) {
			headers.Authorization = `Bearer ${apiKey}`;
		}

		const response = await fetch(`${baseUrl}/v1/models`, {
			method: "GET",
			headers,
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		const data = await response.json();

		if (!data.data || !Array.isArray(data.data)) {
			throw new Error("Invalid response format from vLLM server");
		}

		return data.data.map((model: any) => {
			// vLLM provides max_model_len which is the context window
			const contextWindow = model.max_model_len || 8192;
			const maxTokens = Math.min(contextWindow, 4096); // Cap max tokens

			const vllmModel: Model<any> = {
				id: model.id,
				name: model.id,
				api: "openai-completions" as any,
				provider: "", // Will be set by caller
				baseUrl: `${baseUrl}/v1`,
				reasoning: false,
				input: ["text"],
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
				},
				contextWindow: contextWindow,
				maxTokens: maxTokens,
			};

			return vllmModel;
		});
	} catch (err) {
		console.error("Failed to discover vLLM models:", err);
		throw new Error(`vLLM discovery failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/**
 * 从 LM Studio 服务器发现可用模型。
 * 使用 LM Studio SDK 通过 WebSocket 连接获取已下载的模型列表，
 * 仅保留 LLM 类型的模型，并提取视觉和工具使用能力信息。
 * @param baseUrl - LM Studio 服务器基础 URL（如 "http://localhost:1234"）
 * @param _apiKey - 可选 API Key（LM Studio SDK 未使用）
 * @returns 发现的模型数组
 */
export async function discoverLMStudioModels(baseUrl: string, _apiKey?: string): Promise<Model<any>[]> {
	try {
		// Extract host and port from baseUrl
		const url = new URL(baseUrl);
		const port = url.port ? parseInt(url.port, 10) : 1234;

		// Create LM Studio client
		const client = new LMStudioClient({ baseUrl: `ws://${url.hostname}:${port}` });

		// List all downloaded models
		const models = await client.system.listDownloadedModels();

		// Filter to only LLM models and map to our Model format
		return models
			.filter((model) => model.type === "llm")
			.map((model) => {
				const contextWindow = model.maxContextLength;
				// Use 10x context length like Ollama does
				const maxTokens = contextWindow;

				const lmStudioModel: Model<any> = {
					id: model.path,
					name: model.displayName || model.path,
					api: "openai-completions" as any,
					provider: "", // Will be set by caller
					baseUrl: `${baseUrl}/v1`,
					reasoning: model.trainedForToolUse || false,
					input: model.vision ? ["text", "image"] : ["text"],
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
					},
					contextWindow: contextWindow,
					maxTokens: maxTokens,
				};

				return lmStudioModel;
			});
	} catch (err) {
		console.error("Failed to discover LM Studio models:", err);
		throw new Error(`LM Studio discovery failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/**
 * 根据提供商类型发现模型的便捷函数。
 * 根据 type 参数分发到对应的发现函数。
 * @param type - 提供商类型（"ollama" | "llama.cpp" | "vllm" | "lmstudio"）
 * @param baseUrl - 服务器基础 URL
 * @param apiKey - 可选 API Key
 * @returns 发现的模型数组
 */
export async function discoverModels(
	type: "ollama" | "llama.cpp" | "vllm" | "lmstudio",
	baseUrl: string,
	apiKey?: string,
): Promise<Model<any>[]> {
	switch (type) {
		case "ollama":
			return discoverOllamaModels(baseUrl, apiKey);
		case "llama.cpp":
			return discoverLlamaCppModels(baseUrl, apiKey);
		case "vllm":
			return discoverVLLMModels(baseUrl, apiKey);
		case "lmstudio":
			return discoverLMStudioModels(baseUrl, apiKey);
	}
}
