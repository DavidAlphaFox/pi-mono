/**
 * @file 统一流式处理入口
 *
 * 本文件提供面向用户的高层 API，是使用此包的主要入口：
 * - stream() / complete()：底层 API，需要传入提供商特定的选项
 * - streamSimple() / completeSimple()：简化版 API，自动处理推理级别等配置
 *
 * 导入本文件会自动注册所有内置提供商并设置 HTTP 代理。
 */

import "./providers/register-builtins.js";
import "./utils/http-proxy.js";

import { getApiProvider } from "./api-registry.js";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	ProviderStreamOptions,
	SimpleStreamOptions,
	StreamOptions,
} from "./types.js";

export { getEnvApiKey } from "./env-api-keys.js";

/** 解析 API 对应的提供商，找不到时抛出错误 */
function resolveApiProvider(api: Api) {
	const provider = getApiProvider(api);
	if (!provider) {
		throw new Error(`No API provider registered for api: ${api}`);
	}
	return provider;
}

/** 流式调用模型，返回异步事件流（底层 API，需传入提供商特定选项） */
export function stream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): AssistantMessageEventStream {
	const provider = resolveApiProvider(model.api);
	return provider.stream(model, context, options as StreamOptions);
}

/** 非流式调用模型，等待完整响应后返回（底层 API，需传入提供商特定选项） */
export async function complete<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): Promise<AssistantMessage> {
	const s = stream(model, context, options);
	return s.result();
}

/** 简化版流式调用，自动根据推理级别配置提供商参数 */
export function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const provider = resolveApiProvider(model.api);
	return provider.streamSimple(model, context, options);
}

/** 简化版非流式调用，自动根据推理级别配置提供商参数，等待完整响应后返回 */
export async function completeSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	const s = streamSimple(model, context, options);
	return s.result();
}
