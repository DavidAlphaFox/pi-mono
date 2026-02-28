/**
 * 模型解析、作用域限定和初始选择模块
 *
 * 职责：
 * - 将模型模式字符串（如 "sonnet:high"、"anthropic/*"）解析为具体的 Model 对象
 * - 支持精确匹配、部分匹配、glob 模式匹配和模糊匹配
 * - 处理模型 ID 中的冒号（区分思考级别后缀和模型 ID 的一部分）
 * - 选择初始模型（按优先级：CLI 参数 > 作用域模型 > 会话恢复 > 保存的默认 > 第一个可用）
 * - 提供各提供商的默认模型 ID 映射
 */

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { type Api, type KnownProvider, type Model, modelsAreEqual } from "@mariozechner/pi-ai";
import chalk from "chalk";
import { minimatch } from "minimatch";
import { isValidThinkingLevel } from "../cli/args.js";
import { DEFAULT_THINKING_LEVEL } from "./defaults.js";
import type { ModelRegistry } from "./model-registry.js";

/** 各已知提供商的默认模型 ID */
export const defaultModelPerProvider: Record<KnownProvider, string> = {
	"amazon-bedrock": "us.anthropic.claude-opus-4-6-v1",
	anthropic: "claude-opus-4-6",
	openai: "gpt-5.1-codex",
	"azure-openai-responses": "gpt-5.2",
	"openai-codex": "gpt-5.3-codex",
	google: "gemini-2.5-pro",
	"google-gemini-cli": "gemini-2.5-pro",
	"google-antigravity": "gemini-3-pro-high",
	"google-vertex": "gemini-3-pro-preview",
	"github-copilot": "gpt-4o",
	openrouter: "openai/gpt-5.1-codex",
	"vercel-ai-gateway": "anthropic/claude-opus-4-6",
	xai: "grok-4-fast-non-reasoning",
	groq: "openai/gpt-oss-120b",
	cerebras: "zai-glm-4.6",
	zai: "glm-4.6",
	mistral: "devstral-medium-latest",
	minimax: "MiniMax-M2.1",
	"minimax-cn": "MiniMax-M2.1",
	huggingface: "moonshotai/Kimi-K2.5",
	opencode: "claude-opus-4-6",
	"kimi-coding": "kimi-k2-thinking",
};

/** 作用域模型 - 可能带有显式思考级别 */
export interface ScopedModel {
	model: Model<Api>;
	/** Thinking level if explicitly specified in pattern (e.g., "model:high"), undefined otherwise */
	thinkingLevel?: ThinkingLevel;
}

/**
 * 判断模型 ID 是否为别名（没有日期后缀）
 * 日期格式通常为：-20241022 或 -20250929
 */
function isAlias(id: string): boolean {
	// Check if ID ends with -latest
	if (id.endsWith("-latest")) return true;

	// Check if ID ends with a date pattern (-YYYYMMDD)
	const datePattern = /-\d{8}$/;
	return !datePattern.test(id);
}

/**
 * 尝试将模式字符串匹配到可用模型列表中的模型
 * 匹配优先级：提供商/模型ID 精确匹配 > ID 精确匹配 > 部分匹配（优先别名，其次最新日期版本）
 */
function tryMatchModel(modelPattern: string, availableModels: Model<Api>[]): Model<Api> | undefined {
	// Check for provider/modelId format (provider is everything before the first /)
	const slashIndex = modelPattern.indexOf("/");
	if (slashIndex !== -1) {
		const provider = modelPattern.substring(0, slashIndex);
		const modelId = modelPattern.substring(slashIndex + 1);
		const providerMatch = availableModels.find(
			(m) => m.provider.toLowerCase() === provider.toLowerCase() && m.id.toLowerCase() === modelId.toLowerCase(),
		);
		if (providerMatch) {
			return providerMatch;
		}
		// No exact provider/model match - fall through to other matching
	}

	// Check for exact ID match (case-insensitive)
	const exactMatch = availableModels.find((m) => m.id.toLowerCase() === modelPattern.toLowerCase());
	if (exactMatch) {
		return exactMatch;
	}

	// No exact match - fall back to partial matching
	const matches = availableModels.filter(
		(m) =>
			m.id.toLowerCase().includes(modelPattern.toLowerCase()) ||
			m.name?.toLowerCase().includes(modelPattern.toLowerCase()),
	);

	if (matches.length === 0) {
		return undefined;
	}

	// Separate into aliases and dated versions
	const aliases = matches.filter((m) => isAlias(m.id));
	const datedVersions = matches.filter((m) => !isAlias(m.id));

	if (aliases.length > 0) {
		// Prefer alias - if multiple aliases, pick the one that sorts highest
		aliases.sort((a, b) => b.id.localeCompare(a.id));
		return aliases[0];
	} else {
		// No alias found, pick latest dated version
		datedVersions.sort((a, b) => b.id.localeCompare(a.id));
		return datedVersions[0];
	}
}

/** 模型模式解析结果 */
export interface ParsedModelResult {
	model: Model<Api> | undefined;
	/** 模式中显式指定的思考级别，未指定时为 undefined */
	thinkingLevel?: ThinkingLevel;
	warning: string | undefined;
}

/**
 * 解析模式字符串，提取模型和思考级别
 * 处理 ID 中包含冒号的模型（如 OpenRouter 的 :exacto 后缀）
 *
 * 算法：
 * 1. 先尝试将完整模式作为模型匹配
 * 2. 若匹配成功，返回该模型（思考级别为 undefined）
 * 3. 若未匹配且包含冒号，按最后一个冒号拆分：
 *    - 后缀是有效思考级别：使用该级别，递归匹配前缀
 *    - 后缀无效：发出警告，递归匹配前缀（思考级别为 undefined）
 *
 * @internal 为测试导出
 */
export function parseModelPattern(
	pattern: string,
	availableModels: Model<Api>[],
	options?: { allowInvalidThinkingLevelFallback?: boolean },
): ParsedModelResult {
	// Try exact match first
	const exactMatch = tryMatchModel(pattern, availableModels);
	if (exactMatch) {
		return { model: exactMatch, thinkingLevel: undefined, warning: undefined };
	}

	// No match - try splitting on last colon if present
	const lastColonIndex = pattern.lastIndexOf(":");
	if (lastColonIndex === -1) {
		// No colons, pattern simply doesn't match any model
		return { model: undefined, thinkingLevel: undefined, warning: undefined };
	}

	const prefix = pattern.substring(0, lastColonIndex);
	const suffix = pattern.substring(lastColonIndex + 1);

	if (isValidThinkingLevel(suffix)) {
		// Valid thinking level - recurse on prefix and use this level
		const result = parseModelPattern(prefix, availableModels, options);
		if (result.model) {
			// Only use this thinking level if no warning from inner recursion
			return {
				model: result.model,
				thinkingLevel: result.warning ? undefined : suffix,
				warning: result.warning,
			};
		}
		return result;
	} else {
		// Invalid suffix
		const allowFallback = options?.allowInvalidThinkingLevelFallback ?? true;
		if (!allowFallback) {
			// In strict mode (CLI --model parsing), treat it as part of the model id and fail.
			// This avoids accidentally resolving to a different model.
			return { model: undefined, thinkingLevel: undefined, warning: undefined };
		}

		// Scope mode: recurse on prefix and warn
		const result = parseModelPattern(prefix, availableModels, options);
		if (result.model) {
			return {
				model: result.model,
				thinkingLevel: undefined,
				warning: `Invalid thinking level "${suffix}" in pattern "${pattern}". Using default instead.`,
			};
		}
		return result;
	}
}

/**
 * 将模型模式列表解析为实际的 Model 对象（可选附带思考级别）
 * 格式："pattern:level"，其中 :level 可选
 * 对每个模式，查找所有匹配模型并选择最佳版本：
 * 1. 优先别名（如 claude-sonnet-4-5）而非带日期版本（claude-sonnet-4-5-20250929）
 * 2. 无别名时选最新日期版本
 *
 * 支持 glob 模式（*、?、[）和 ID 中包含冒号的模型
 */
export async function resolveModelScope(patterns: string[], modelRegistry: ModelRegistry): Promise<ScopedModel[]> {
	const availableModels = await modelRegistry.getAvailable();
	const scopedModels: ScopedModel[] = [];

	for (const pattern of patterns) {
		// Check if pattern contains glob characters
		if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[")) {
			// Extract optional thinking level suffix (e.g., "provider/*:high")
			const colonIdx = pattern.lastIndexOf(":");
			let globPattern = pattern;
			let thinkingLevel: ThinkingLevel | undefined;

			if (colonIdx !== -1) {
				const suffix = pattern.substring(colonIdx + 1);
				if (isValidThinkingLevel(suffix)) {
					thinkingLevel = suffix;
					globPattern = pattern.substring(0, colonIdx);
				}
			}

			// Match against "provider/modelId" format OR just model ID
			// This allows "*sonnet*" to match without requiring "anthropic/*sonnet*"
			const matchingModels = availableModels.filter((m) => {
				const fullId = `${m.provider}/${m.id}`;
				return minimatch(fullId, globPattern, { nocase: true }) || minimatch(m.id, globPattern, { nocase: true });
			});

			if (matchingModels.length === 0) {
				console.warn(chalk.yellow(`Warning: No models match pattern "${pattern}"`));
				continue;
			}

			for (const model of matchingModels) {
				if (!scopedModels.find((sm) => modelsAreEqual(sm.model, model))) {
					scopedModels.push({ model, thinkingLevel });
				}
			}
			continue;
		}

		const { model, thinkingLevel, warning } = parseModelPattern(pattern, availableModels);

		if (warning) {
			console.warn(chalk.yellow(`Warning: ${warning}`));
		}

		if (!model) {
			console.warn(chalk.yellow(`Warning: No models match pattern "${pattern}"`));
			continue;
		}

		// Avoid duplicates
		if (!scopedModels.find((sm) => modelsAreEqual(sm.model, model))) {
			scopedModels.push({ model, thinkingLevel });
		}
	}

	return scopedModels;
}

/** CLI 模型解析结果 */
export interface ResolveCliModelResult {
	model: Model<Api> | undefined;
	thinkingLevel?: ThinkingLevel;
	warning: string | undefined;
	/** 适合 CLI 显示的错误消息，设置时 model 为 undefined */
	error: string | undefined;
}

/**
 * 从 CLI 标志解析单个模型
 *
 * 支持的格式：
 * - --provider <provider> --model <pattern>
 * - --model <provider>/<pattern>
 * - 模糊匹配（同模型作用域规则：精确 ID > 部分 ID/名称匹配）
 *
 * 注意：不直接应用思考级别，但会从 "<pattern>:<thinking>" 解析并返回思考级别供调用者使用
 */
export function resolveCliModel(options: {
	cliProvider?: string;
	cliModel?: string;
	modelRegistry: ModelRegistry;
}): ResolveCliModelResult {
	const { cliProvider, cliModel, modelRegistry } = options;

	if (!cliModel) {
		return { model: undefined, warning: undefined, error: undefined };
	}

	// Important: use *all* models here, not just models with pre-configured auth.
	// This allows "--api-key" to be used for first-time setup.
	const availableModels = modelRegistry.getAll();
	if (availableModels.length === 0) {
		return {
			model: undefined,
			warning: undefined,
			error: "No models available. Check your installation or add models to models.json.",
		};
	}

	// Build canonical provider lookup (case-insensitive)
	const providerMap = new Map<string, string>();
	for (const m of availableModels) {
		providerMap.set(m.provider.toLowerCase(), m.provider);
	}

	let provider = cliProvider ? providerMap.get(cliProvider.toLowerCase()) : undefined;
	if (cliProvider && !provider) {
		return {
			model: undefined,
			warning: undefined,
			error: `Unknown provider "${cliProvider}". Use --list-models to see available providers/models.`,
		};
	}

	// If no explicit --provider, try to interpret "provider/model" format first.
	// When the prefix before the first slash matches a known provider, prefer that
	// interpretation over matching models whose IDs literally contain slashes
	// (e.g. "zai/glm-5" should resolve to provider=zai, model=glm-5, not to a
	// vercel-ai-gateway model with id "zai/glm-5").
	let pattern = cliModel;
	let inferredProvider = false;

	if (!provider) {
		const slashIndex = cliModel.indexOf("/");
		if (slashIndex !== -1) {
			const maybeProvider = cliModel.substring(0, slashIndex);
			const canonical = providerMap.get(maybeProvider.toLowerCase());
			if (canonical) {
				provider = canonical;
				pattern = cliModel.substring(slashIndex + 1);
				inferredProvider = true;
			}
		}
	}

	// If no provider was inferred from the slash, try exact matches without provider inference.
	// This handles models whose IDs naturally contain slashes (e.g. OpenRouter-style IDs).
	if (!provider) {
		const lower = cliModel.toLowerCase();
		const exact = availableModels.find(
			(m) => m.id.toLowerCase() === lower || `${m.provider}/${m.id}`.toLowerCase() === lower,
		);
		if (exact) {
			return { model: exact, warning: undefined, thinkingLevel: undefined, error: undefined };
		}
	}

	if (cliProvider && provider) {
		// If both were provided, tolerate --model <provider>/<pattern> by stripping the provider prefix
		const prefix = `${provider}/`;
		if (cliModel.toLowerCase().startsWith(prefix.toLowerCase())) {
			pattern = cliModel.substring(prefix.length);
		}
	}

	const candidates = provider ? availableModels.filter((m) => m.provider === provider) : availableModels;
	const { model, thinkingLevel, warning } = parseModelPattern(pattern, candidates, {
		allowInvalidThinkingLevelFallback: false,
	});

	if (model) {
		return { model, thinkingLevel, warning, error: undefined };
	}

	// If we inferred a provider from the slash but found no match within that provider,
	// fall back to matching the full input as a raw model id across all models.
	// This handles OpenRouter-style IDs like "openai/gpt-4o:extended" where "openai"
	// looks like a provider but the full string is actually a model id on openrouter.
	if (inferredProvider) {
		const lower = cliModel.toLowerCase();
		const exact = availableModels.find(
			(m) => m.id.toLowerCase() === lower || `${m.provider}/${m.id}`.toLowerCase() === lower,
		);
		if (exact) {
			return { model: exact, warning: undefined, thinkingLevel: undefined, error: undefined };
		}
		// Also try parseModelPattern on the full input against all models
		const fallback = parseModelPattern(cliModel, availableModels, {
			allowInvalidThinkingLevelFallback: false,
		});
		if (fallback.model) {
			return {
				model: fallback.model,
				thinkingLevel: fallback.thinkingLevel,
				warning: fallback.warning,
				error: undefined,
			};
		}
	}

	const display = provider ? `${provider}/${pattern}` : cliModel;
	return {
		model: undefined,
		thinkingLevel: undefined,
		warning,
		error: `Model "${display}" not found. Use --list-models to see available models.`,
	};
}

/** 初始模型查找结果 */
export interface InitialModelResult {
	model: Model<Api> | undefined;
	thinkingLevel: ThinkingLevel;
	/** 降级消息，当无法使用首选模型时提供提示 */
	fallbackMessage: string | undefined;
}

/**
 * 按优先级查找初始模型：
 * 1. CLI 参数（provider + model）
 * 2. 作用域模型列表的第一个（非继续/恢复时）
 * 3. 从会话恢复（继续/恢复时）
 * 4. 设置中保存的默认模型
 * 5. 第一个有有效 API key 的可用模型
 */
export async function findInitialModel(options: {
	cliProvider?: string;
	cliModel?: string;
	scopedModels: ScopedModel[];
	isContinuing: boolean;
	defaultProvider?: string;
	defaultModelId?: string;
	defaultThinkingLevel?: ThinkingLevel;
	modelRegistry: ModelRegistry;
}): Promise<InitialModelResult> {
	const {
		cliProvider,
		cliModel,
		scopedModels,
		isContinuing,
		defaultProvider,
		defaultModelId,
		defaultThinkingLevel,
		modelRegistry,
	} = options;

	let model: Model<Api> | undefined;
	let thinkingLevel: ThinkingLevel = DEFAULT_THINKING_LEVEL;

	// 1. CLI args take priority
	if (cliProvider && cliModel) {
		const found = modelRegistry.find(cliProvider, cliModel);
		if (!found) {
			console.error(chalk.red(`Model ${cliProvider}/${cliModel} not found`));
			process.exit(1);
		}
		return { model: found, thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
	}

	// 2. Use first model from scoped models (skip if continuing/resuming)
	if (scopedModels.length > 0 && !isContinuing) {
		return {
			model: scopedModels[0].model,
			thinkingLevel: scopedModels[0].thinkingLevel ?? defaultThinkingLevel ?? DEFAULT_THINKING_LEVEL,
			fallbackMessage: undefined,
		};
	}

	// 3. Try saved default from settings
	if (defaultProvider && defaultModelId) {
		const found = modelRegistry.find(defaultProvider, defaultModelId);
		if (found) {
			model = found;
			if (defaultThinkingLevel) {
				thinkingLevel = defaultThinkingLevel;
			}
			return { model, thinkingLevel, fallbackMessage: undefined };
		}
	}

	// 4. Try first available model with valid API key
	const availableModels = await modelRegistry.getAvailable();

	if (availableModels.length > 0) {
		// Try to find a default model from known providers
		for (const provider of Object.keys(defaultModelPerProvider) as KnownProvider[]) {
			const defaultId = defaultModelPerProvider[provider];
			const match = availableModels.find((m) => m.provider === provider && m.id === defaultId);
			if (match) {
				return { model: match, thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
			}
		}

		// If no default found, use first available
		return { model: availableModels[0], thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
	}

	// 5. No model found
	return { model: undefined, thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
}

/**
 * 从会话恢复模型，不可用时降级到其他可用模型
 */
export async function restoreModelFromSession(
	savedProvider: string,
	savedModelId: string,
	currentModel: Model<Api> | undefined,
	shouldPrintMessages: boolean,
	modelRegistry: ModelRegistry,
): Promise<{ model: Model<Api> | undefined; fallbackMessage: string | undefined }> {
	const restoredModel = modelRegistry.find(savedProvider, savedModelId);

	// Check if restored model exists and has a valid API key
	const hasApiKey = restoredModel ? !!(await modelRegistry.getApiKey(restoredModel)) : false;

	if (restoredModel && hasApiKey) {
		if (shouldPrintMessages) {
			console.log(chalk.dim(`Restored model: ${savedProvider}/${savedModelId}`));
		}
		return { model: restoredModel, fallbackMessage: undefined };
	}

	// Model not found or no API key - fall back
	const reason = !restoredModel ? "model no longer exists" : "no API key available";

	if (shouldPrintMessages) {
		console.error(chalk.yellow(`Warning: Could not restore model ${savedProvider}/${savedModelId} (${reason}).`));
	}

	// If we already have a model, use it as fallback
	if (currentModel) {
		if (shouldPrintMessages) {
			console.log(chalk.dim(`Falling back to: ${currentModel.provider}/${currentModel.id}`));
		}
		return {
			model: currentModel,
			fallbackMessage: `Could not restore model ${savedProvider}/${savedModelId} (${reason}). Using ${currentModel.provider}/${currentModel.id}.`,
		};
	}

	// Try to find any available model
	const availableModels = await modelRegistry.getAvailable();

	if (availableModels.length > 0) {
		// Try to find a default model from known providers
		let fallbackModel: Model<Api> | undefined;
		for (const provider of Object.keys(defaultModelPerProvider) as KnownProvider[]) {
			const defaultId = defaultModelPerProvider[provider];
			const match = availableModels.find((m) => m.provider === provider && m.id === defaultId);
			if (match) {
				fallbackModel = match;
				break;
			}
		}

		// If no default found, use first available
		if (!fallbackModel) {
			fallbackModel = availableModels[0];
		}

		if (shouldPrintMessages) {
			console.log(chalk.dim(`Falling back to: ${fallbackModel.provider}/${fallbackModel.id}`));
		}

		return {
			model: fallbackModel,
			fallbackMessage: `Could not restore model ${savedProvider}/${savedModelId} (${reason}). Using ${fallbackModel.provider}/${fallbackModel.id}.`,
		};
	}

	// No models available
	return { model: undefined, fallbackMessage: undefined };
}
