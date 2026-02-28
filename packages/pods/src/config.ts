/**
 * @file 配置管理模块
 *
 * 本文件负责管理 Pod 配置的持久化存储，包括：
 * - 配置文件的读取和写入（存储在 ~/.pi/pods.json）
 * - Pod 的增删改查操作
 * - 活跃 Pod 的获取和切换
 *
 * 配置目录可通过 PI_CONFIG_DIR 环境变量自定义，默认为 ~/.pi
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { Config, Pod } from "./types.js";

/**
 * 获取配置目录路径
 * 优先使用 PI_CONFIG_DIR 环境变量，默认为 ~/.pi
 * 如果目录不存在则自动创建
 * @returns 配置目录的绝对路径
 */
const getConfigDir = (): string => {
	const configDir = process.env.PI_CONFIG_DIR || join(homedir(), ".pi");
	if (!existsSync(configDir)) {
		mkdirSync(configDir, { recursive: true });
	}
	return configDir;
};

/**
 * 获取配置文件路径
 * @returns pods.json 配置文件的绝对路径
 */
const getConfigPath = (): string => {
	return join(getConfigDir(), "pods.json");
};

/**
 * 加载配置文件
 * 从磁盘读取并解析 pods.json 配置文件
 * @returns 解析后的配置对象，文件不存在或解析失败时返回空配置
 */
export const loadConfig = (): Config => {
	const configPath = getConfigPath();
	if (!existsSync(configPath)) {
		// 配置文件不存在时返回空配置
		return { pods: {} };
	}
	try {
		const data = readFileSync(configPath, "utf-8");
		return JSON.parse(data);
	} catch (e) {
		console.error(`Error reading config: ${e}`);
		return { pods: {} };
	}
};

/**
 * 保存配置到磁盘
 * 将配置对象序列化为 JSON 并写入 pods.json 文件
 * @param config - 要保存的配置对象
 */
export const saveConfig = (config: Config): void => {
	const configPath = getConfigPath();
	try {
		writeFileSync(configPath, JSON.stringify(config, null, 2));
	} catch (e) {
		console.error(`Error saving config: ${e}`);
		process.exit(1);
	}
};

/**
 * 获取当前活跃的 Pod
 * @returns 活跃 Pod 的名称和配置信息，无活跃 Pod 时返回 null
 */
export const getActivePod = (): { name: string; pod: Pod } | null => {
	const config = loadConfig();
	if (!config.active || !config.pods[config.active]) {
		return null;
	}
	return { name: config.active, pod: config.pods[config.active] };
};

/**
 * 添加一个新的 Pod 到配置中
 * 如果当前没有活跃 Pod，会自动将新添加的 Pod 设为活跃
 * @param name - Pod 名称
 * @param pod - Pod 配置信息
 */
export const addPod = (name: string, pod: Pod): void => {
	const config = loadConfig();
	config.pods[name] = pod;
	// 如果没有活跃 Pod，将新添加的设为活跃
	if (!config.active) {
		config.active = name;
	}
	saveConfig(config);
};

/**
 * 从配置中移除一个 Pod
 * 如果被移除的是当前活跃 Pod，会清除活跃状态
 * @param name - 要移除的 Pod 名称
 */
export const removePod = (name: string): void => {
	const config = loadConfig();
	delete config.pods[name];
	// 如果移除的是活跃 Pod，清除活跃状态
	if (config.active === name) {
		config.active = undefined;
	}
	saveConfig(config);
};

/**
 * 设置活跃 Pod
 * @param name - 要设为活跃的 Pod 名称，必须是已配置的 Pod
 */
export const setActivePod = (name: string): void => {
	const config = loadConfig();
	if (!config.pods[name]) {
		console.error(`Pod '${name}' not found`);
		process.exit(1);
	}
	config.active = name;
	saveConfig(config);
};
