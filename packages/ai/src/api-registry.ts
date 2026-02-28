/**
 * @file API 提供商注册表
 *
 * 本文件实现了一个全局的 API 提供商注册表，用于：
 * - 注册和管理各 AI API 提供商（Anthropic、OpenAI、Google 等）
 * - 提供统一的 stream 和 streamSimple 接口
 * - 支持按 sourceId 批量注销提供商（用于插件系统）
 * - 通过类型包装确保 API 类型安全
 */

import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
} from "./types.js";

/** API 流式处理函数类型（内部使用，类型已擦除） */
export type ApiStreamFunction = (
	model: Model<Api>,
	context: Context,
	options?: StreamOptions,
) => AssistantMessageEventStream;

/** 简化版 API 流式处理函数类型（内部使用） */
export type ApiStreamSimpleFunction = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/** API 提供商接口，定义一个 API 协议的流式处理能力 */
export interface ApiProvider<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> {
	api: TApi;
	stream: StreamFunction<TApi, TOptions>;
	streamSimple: StreamFunction<TApi, SimpleStreamOptions>;
}

/** 内部使用的 API 提供商接口（类型已擦除） */
interface ApiProviderInternal {
	api: Api;
	stream: ApiStreamFunction;
	streamSimple: ApiStreamSimpleFunction;
}

/** 注册表中的提供商条目，包含可选的来源标识 */
type RegisteredApiProvider = {
	provider: ApiProviderInternal;
	sourceId?: string;
};

/** 全局 API 提供商注册表，以 API 标识为键 */
const apiProviderRegistry = new Map<string, RegisteredApiProvider>();

/** 包装流式函数，添加 API 类型校验 */
function wrapStream<TApi extends Api, TOptions extends StreamOptions>(
	api: TApi,
	stream: StreamFunction<TApi, TOptions>,
): ApiStreamFunction {
	return (model, context, options) => {
		if (model.api !== api) {
			throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		}
		return stream(model as Model<TApi>, context, options as TOptions);
	};
}

/** 包装简化版流式函数，添加 API 类型校验 */
function wrapStreamSimple<TApi extends Api>(
	api: TApi,
	streamSimple: StreamFunction<TApi, SimpleStreamOptions>,
): ApiStreamSimpleFunction {
	return (model, context, options) => {
		if (model.api !== api) {
			throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		}
		return streamSimple(model as Model<TApi>, context, options);
	};
}

/** 注册一个 API 提供商到全局注册表 */
export function registerApiProvider<TApi extends Api, TOptions extends StreamOptions>(
	provider: ApiProvider<TApi, TOptions>,
	sourceId?: string,
): void {
	apiProviderRegistry.set(provider.api, {
		provider: {
			api: provider.api,
			stream: wrapStream(provider.api, provider.stream),
			streamSimple: wrapStreamSimple(provider.api, provider.streamSimple),
		},
		sourceId,
	});
}

/** 根据 API 标识获取对应的提供商 */
export function getApiProvider(api: Api): ApiProviderInternal | undefined {
	return apiProviderRegistry.get(api)?.provider;
}

/** 获取所有已注册的 API 提供商列表 */
export function getApiProviders(): ApiProviderInternal[] {
	return Array.from(apiProviderRegistry.values(), (entry) => entry.provider);
}

/** 按来源 ID 批量注销 API 提供商 */
export function unregisterApiProviders(sourceId: string): void {
	for (const [api, entry] of apiProviderRegistry.entries()) {
		if (entry.sourceId === sourceId) {
			apiProviderRegistry.delete(api);
		}
	}
}

/** 清空所有已注册的 API 提供商 */
export function clearApiProviders(): void {
	apiProviderRegistry.clear();
}
