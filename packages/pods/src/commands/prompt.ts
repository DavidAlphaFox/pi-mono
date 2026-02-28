/**
 * @file Agent 交互命令模块
 *
 * 本文件实现了通过 Agent 与部署在 GPU Pod 上的模型进行对话的功能。
 * 支持交互式聊天和单次消息模式，可将 vLLM 模型作为代码助手使用。
 *
 * 注意：当前实现为占位符，Agent 集成尚未完成。
 */
import chalk from "chalk";
import { getActivePod, loadConfig } from "../config.js";

// ────────────────────────────────────────────────────────────────────────────────
// 类型定义
// ────────────────────────────────────────────────────────────────────────────────

/**
 * Prompt 命令选项
 */
interface PromptOptions {
	/** 指定 Pod 名称（覆盖活跃 Pod） */
	pod?: string;
	/** vLLM API 密钥 */
	apiKey?: string;
}

// ────────────────────────────────────────────────────────────────────────────────
// 主要功能
// ────────────────────────────────────────────────────────────────────────────────

/**
 * 使用 Agent 与指定模型进行交互
 *
 * 功能流程：
 * 1. 获取目标 Pod 和模型的配置信息
 * 2. 从 SSH 连接字符串中提取主机地址
 * 3. 构建 Agent 的系统提示词（代码导航助手角色）
 * 4. 组装参数并调用 Agent 主函数
 *
 * @param modelName - 已部署模型的别名（需已在 Pod 上启动）
 * @param userArgs - 用户提供的参数列表（消息内容、--continue、--json 等）
 * @param opts - 可选配置
 * @param opts.pod - 指定 Pod 名称
 * @param opts.apiKey - API 密钥
 */
export async function promptModel(modelName: string, userArgs: string[], opts: PromptOptions = {}) {
	// 获取 Pod 和模型配置：优先使用指定的 Pod，否则使用活跃 Pod
	const activePod = opts.pod ? { name: opts.pod, pod: loadConfig().pods[opts.pod] } : getActivePod();

	if (!activePod) {
		console.error(chalk.red("No active pod. Use 'pi pods active <name>' to set one."));
		process.exit(1);
	}

	const { name: podName, pod } = activePod;
	const modelConfig = pod.models[modelName];

	if (!modelConfig) {
		console.error(chalk.red(`Model '${modelName}' not found on pod '${podName}'`));
		process.exit(1);
	}

	// 从 SSH 连接字符串中提取远程主机地址（如 "ssh root@1.2.3.4" -> "1.2.3.4"）
	const host =
		pod.ssh
			.split(" ")
			.find((p) => p.includes("@"))
			?.split("@")[1] ?? "localhost";

	// 构建 Agent 系统提示词：定义代码导航助手的行为规范
	const systemPrompt = `You help the user understand and navigate the codebase in the current working directory.

You can read files, list directories, and execute shell commands via the respective tools.

Do not output file contents you read via the read_file tool directly, unless asked to.

Do not output markdown tables as part of your responses.

Keep your responses concise and relevant to the user's request.

File paths you output must include line numbers where possible, e.g. "src/index.ts:10-20" for lines 10 to 20 in src/index.ts.

Current working directory: ${process.cwd()}`;

	// 组装 Agent 启动参数
	const args: string[] = [];

	// 添加由本工具控制的基础配置参数
	args.push(
		"--base-url",
		`http://${host}:${modelConfig.port}/v1`,
		"--model",
		modelConfig.model,
		"--api-key",
		opts.apiKey || process.env.PI_API_KEY || "dummy",
		"--api",
		// 根据模型名称判断使用 responses API 还是 completions API
		modelConfig.model.toLowerCase().includes("gpt-oss") ? "responses" : "completions",
		"--system-prompt",
		systemPrompt,
	);

	// 透传所有用户提供的参数（消息内容、--continue、--json 等）
	args.push(...userArgs);

	// 调用 Agent 主函数（当前为未实现的占位符）
	try {
		throw new Error("Not implemented");
	} catch (err: any) {
		console.error(chalk.red(`Agent error: ${err.message}`));
		process.exit(1);
	}
}
