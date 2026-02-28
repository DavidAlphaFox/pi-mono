/**
 * @file 模型配置管理模块
 *
 * 本文件负责加载和查询预定义的模型配置信息（从 models.json 文件读取），包括：
 * - 根据可用 GPU 硬件匹配最佳模型配置
 * - 查询已知模型列表
 * - 获取模型的显示名称
 *
 * models.json 中定义了每个模型在不同 GPU 数量和类型下的最优启动参数。
 */
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { GPU } from "./types.js";

/** 当前文件的绝对路径 */
const __filename = fileURLToPath(import.meta.url);
/** 当前文件所在目录的绝对路径 */
const __dirname = dirname(__filename);

/**
 * 单个模型配置
 * 定义在特定 GPU 数量和类型下的 vLLM 启动参数
 */
interface ModelConfig {
	/** 所需 GPU 数量 */
	gpuCount: number;
	/** 兼容的 GPU 类型列表（如 ["H100", "H200"]），为空表示不限类型 */
	gpuTypes?: string[];
	/** vLLM 启动参数列表 */
	args: string[];
	/** 额外的环境变量 */
	env?: Record<string, string>;
	/** 配置备注信息 */
	notes?: string;
}

/**
 * 模型信息
 * 包含模型的显示名称和所有可用配置
 */
interface ModelInfo {
	/** 模型显示名称 */
	name: string;
	/** 该模型的所有可用配置（不同 GPU 数量/类型对应不同配置） */
	configs: ModelConfig[];
	/** 模型级别的备注信息 */
	notes?: string;
}

/**
 * models.json 文件的数据结构
 */
interface ModelsData {
	/** 所有模型信息，以模型 ID 为键 */
	models: Record<string, ModelInfo>;
}

// 加载模型配置文件（相对于当前文件路径解析）
const modelsJsonPath = join(__dirname, "models.json");
const modelsData: ModelsData = JSON.parse(readFileSync(modelsJsonPath, "utf-8"));

/**
 * 根据可用 GPU 获取模型的最佳配置
 *
 * 匹配逻辑：
 * 1. 首先尝试精确匹配 GPU 数量和 GPU 类型
 * 2. 如果没有精确匹配，退而求其次只匹配 GPU 数量
 *
 * @param modelId - 模型标识符
 * @param gpus - Pod 上可用的 GPU 列表
 * @param requestedGpuCount - 请求使用的 GPU 数量
 * @returns 匹配到的配置（包含启动参数、环境变量和备注），未找到时返回 null
 */
export const getModelConfig = (
	modelId: string,
	gpus: GPU[],
	requestedGpuCount: number,
): { args: string[]; env?: Record<string, string>; notes?: string } | null => {
	const modelInfo = modelsData.models[modelId];
	if (!modelInfo) {
		// 未知模型，无默认配置
		return null;
	}

	// 从第一个 GPU 名称中提取 GPU 型号（如 "NVIDIA H200" -> "H200"）
	const gpuType = gpus[0]?.name?.replace("NVIDIA", "")?.trim()?.split(" ")[0] || "";

	// 查找最佳匹配的配置
	let bestConfig: ModelConfig | null = null;

	for (const config of modelInfo.configs) {
		// 检查 GPU 数量是否匹配
		if (config.gpuCount !== requestedGpuCount) {
			continue;
		}

		// 检查 GPU 类型是否匹配（如果配置中指定了类型要求）
		if (config.gpuTypes && config.gpuTypes.length > 0) {
			const typeMatches = config.gpuTypes.some((type) => gpuType.includes(type) || type.includes(gpuType));
			if (!typeMatches) {
				continue;
			}
		}

		// 找到匹配的配置
		bestConfig = config;
		break;
	}

	// 如果没有精确匹配（类型+数量），尝试只匹配 GPU 数量
	if (!bestConfig) {
		for (const config of modelInfo.configs) {
			if (config.gpuCount === requestedGpuCount) {
				bestConfig = config;
				break;
			}
		}
	}

	if (!bestConfig) {
		// 未找到合适的配置
		return null;
	}

	return {
		args: [...bestConfig.args],
		env: bestConfig.env ? { ...bestConfig.env } : undefined,
		notes: bestConfig.notes || modelInfo.notes,
	};
};

/**
 * 检查模型是否为已知的预定义模型
 * @param modelId - 模型标识符
 * @returns 如果模型在 models.json 中有定义则返回 true
 */
export const isKnownModel = (modelId: string): boolean => {
	return modelId in modelsData.models;
};

/**
 * 获取所有已知模型的 ID 列表
 * @returns 模型 ID 字符串数组
 */
export const getKnownModels = (): string[] => {
	return Object.keys(modelsData.models);
};

/**
 * 获取模型的显示名称
 * @param modelId - 模型标识符
 * @returns 模型显示名称，未找到时返回原始 ID
 */
export const getModelName = (modelId: string): string => {
	return modelsData.models[modelId]?.name || modelId;
};
