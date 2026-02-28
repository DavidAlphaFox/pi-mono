/**
 * @file 模型管理命令模块
 *
 * 本文件实现了 vLLM 模型生命周期管理的所有命令，包括：
 * - 启动模型（startModel）：在 GPU Pod 上部署 vLLM 模型服务
 * - 停止模型（stopModel / stopAllModels）：终止运行中的模型进程
 * - 列出模型（listModels）：显示当前 Pod 上所有运行中的模型及其状态
 * - 查看日志（viewLogs）：流式输出指定模型的运行日志
 * - 显示已知模型（showKnownModels）：展示所有预定义模型及其硬件兼容性
 */
import chalk from "chalk";
import { spawn } from "child_process";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { getActivePod, loadConfig, saveConfig } from "../config.js";
import { getModelConfig, getModelName, isKnownModel } from "../model-configs.js";
import { sshExec } from "../ssh.js";
import type { Pod } from "../types.js";

/**
 * 获取要操作的 Pod（支持 --pod 参数覆盖活跃 Pod）
 * @param podOverride - 可选的 Pod 名称覆盖，优先于活跃 Pod
 * @returns Pod 的名称和配置信息
 */
const getPod = (podOverride?: string): { name: string; pod: Pod } => {
	if (podOverride) {
		const config = loadConfig();
		const pod = config.pods[podOverride];
		if (!pod) {
			console.error(chalk.red(`Pod '${podOverride}' not found`));
			process.exit(1);
		}
		return { name: podOverride, pod };
	}

	const active = getActivePod();
	if (!active) {
		console.error(chalk.red("No active pod. Use 'pi pods active <name>' to set one."));
		process.exit(1);
	}
	return active;
};

/**
 * 获取下一个可用端口
 * 从 8001 开始递增，跳过已被其他模型占用的端口
 * @param pod - Pod 配置信息
 * @returns 可用的端口号
 */
const getNextPort = (pod: Pod): number => {
	const usedPorts = Object.values(pod.models).map((m) => m.port);
	let port = 8001;
	while (usedPorts.includes(port)) {
		port++;
	}
	return port;
};

/**
 * 为模型部署选择 GPU
 * 使用轮询策略，优先选择当前负载最低的 GPU
 * @param pod - Pod 配置信息
 * @param count - 需要的 GPU 数量，默认为 1
 * @returns 选中的 GPU 设备 ID 列表
 */
const selectGPUs = (pod: Pod, count: number = 1): number[] => {
	// 如果请求所有 GPU，直接返回全部
	if (count === pod.gpus.length) {
		return pod.gpus.map((g) => g.id);
	}

	// 统计每个 GPU 被已部署模型使用的次数
	const gpuUsage = new Map<number, number>();
	for (const gpu of pod.gpus) {
		gpuUsage.set(gpu.id, 0);
	}

	for (const model of Object.values(pod.models)) {
		for (const gpuId of model.gpu) {
			gpuUsage.set(gpuId, (gpuUsage.get(gpuId) || 0) + 1);
		}
	}

	// 按使用次数升序排列，优先选择最空闲的 GPU
	const sortedGPUs = Array.from(gpuUsage.entries())
		.sort((a, b) => a[1] - b[1])
		.map((entry) => entry[0]);

	// 返回最空闲的前 N 个 GPU
	return sortedGPUs.slice(0, count);
};

/**
 * 启动模型
 * 在指定 Pod 上部署 vLLM 模型服务，包括：
 * 1. 确定 GPU 分配和 vLLM 启动参数
 * 2. 上传并执行模型运行脚本
 * 3. 监控启动日志，等待服务就绪
 * 4. 输出连接信息和使用示例
 *
 * @param modelId - 模型标识符（如 HuggingFace 模型 ID）
 * @param name - 模型部署别名
 * @param options - 启动选项
 * @param options.pod - 指定 Pod 名称（覆盖活跃 Pod）
 * @param options.vllmArgs - 自定义 vLLM 启动参数（使用时忽略其他选项）
 * @param options.memory - GPU 显存使用比例（如 "90%"）
 * @param options.context - 上下文窗口大小（如 "32k"）
 * @param options.gpus - 使用的 GPU 数量
 */
export const startModel = async (
	modelId: string,
	name: string,
	options: {
		pod?: string;
		vllmArgs?: string[];
		memory?: string;
		context?: string;
		gpus?: number;
	},
) => {
	const { name: podName, pod } = getPod(options.pod);

	// 验证前置条件
	if (!pod.modelsPath) {
		console.error(chalk.red("Pod does not have a models path configured"));
		process.exit(1);
	}
	if (pod.models[name]) {
		console.error(chalk.red(`Model '${name}' already exists on pod '${podName}'`));
		process.exit(1);
	}

	const port = getNextPort(pod);

	// 确定 GPU 分配方案和 vLLM 启动参数
	let gpus: number[] = [];
	let vllmArgs: string[] = [];
	let modelConfig = null;

	if (options.vllmArgs?.length) {
		// 使用自定义参数时，GPU 分配由 vLLM 自行管理
		vllmArgs = options.vllmArgs;
		console.log(chalk.gray("Using custom vLLM args, GPU allocation managed by vLLM"));
	} else if (isKnownModel(modelId)) {
		// 已知模型：根据预定义配置分配 GPU
		if (options.gpus) {
			// 用户指定了 GPU 数量
			if (options.gpus > pod.gpus.length) {
				console.error(chalk.red(`Error: Requested ${options.gpus} GPUs but pod only has ${pod.gpus.length}`));
				process.exit(1);
			}

			// 查找匹配请求 GPU 数量的配置
			modelConfig = getModelConfig(modelId, pod.gpus, options.gpus);
			if (modelConfig) {
				gpus = selectGPUs(pod, options.gpus);
				vllmArgs = [...(modelConfig.args || [])];
			} else {
				console.error(
					chalk.red(`Model '${getModelName(modelId)}' does not have a configuration for ${options.gpus} GPU(s)`),
				);
				console.error(chalk.yellow("Available configurations:"));

				// 显示所有可用的 GPU 配置方案
				for (let gpuCount = 1; gpuCount <= pod.gpus.length; gpuCount++) {
					const config = getModelConfig(modelId, pod.gpus, gpuCount);
					if (config) {
						console.error(chalk.gray(`  - ${gpuCount} GPU(s)`));
					}
				}
				process.exit(1);
			}
		} else {
			// 未指定 GPU 数量：从最多 GPU 开始逐步减少，找到第一个兼容配置
			for (let gpuCount = pod.gpus.length; gpuCount >= 1; gpuCount--) {
				modelConfig = getModelConfig(modelId, pod.gpus, gpuCount);
				if (modelConfig) {
					gpus = selectGPUs(pod, gpuCount);
					vllmArgs = [...(modelConfig.args || [])];
					break;
				}
			}
			if (!modelConfig) {
				console.error(chalk.red(`Model '${getModelName(modelId)}' not compatible with this pod's GPUs`));
				process.exit(1);
			}
		}
	} else {
		// 未知模型：默认使用单个 GPU
		if (options.gpus) {
			console.error(chalk.red("Error: --gpus can only be used with predefined models"));
			console.error(chalk.yellow("For custom models, use --vllm with tensor-parallel-size or similar arguments"));
			process.exit(1);
		}
		gpus = selectGPUs(pod, 1);
		console.log(chalk.gray("Unknown model, defaulting to single GPU"));
	}

	// 应用用户指定的显存和上下文窗口覆盖参数
	if (!options.vllmArgs?.length) {
		if (options.memory) {
			// 将百分比转换为小数（如 "90%" -> 0.9）
			const fraction = parseFloat(options.memory.replace("%", "")) / 100;
			vllmArgs = vllmArgs.filter((arg) => !arg.includes("gpu-memory-utilization"));
			vllmArgs.push("--gpu-memory-utilization", String(fraction));
		}
		if (options.context) {
			// 将简写转换为具体的 token 数量（如 "32k" -> 32768）
			const contextSizes: Record<string, number> = {
				"4k": 4096,
				"8k": 8192,
				"16k": 16384,
				"32k": 32768,
				"64k": 65536,
				"128k": 131072,
			};
			const maxTokens = contextSizes[options.context.toLowerCase()] || parseInt(options.context, 10);
			vllmArgs = vllmArgs.filter((arg) => !arg.includes("max-model-len"));
			vllmArgs.push("--max-model-len", String(maxTokens));
		}
	}

	// 显示部署信息
	console.log(chalk.green(`Starting model '${name}' on pod '${podName}'...`));
	console.log(`Model: ${modelId}`);
	console.log(`Port: ${port}`);
	console.log(`GPU(s): ${gpus.length ? gpus.join(", ") : "Managed by vLLM"}`);
	if (modelConfig?.notes) console.log(chalk.yellow(`Note: ${modelConfig.notes}`));
	console.log("");

	// 读取并定制模型运行脚本，替换占位符为实际值
	const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "../../scripts/model_run.sh");
	let scriptContent = readFileSync(scriptPath, "utf-8");

	// 替换脚本模板中的占位符（使用 heredoc 的 'EOF' 引号模式，无需转义）
	scriptContent = scriptContent
		.replace("{{MODEL_ID}}", modelId)
		.replace("{{NAME}}", name)
		.replace("{{PORT}}", String(port))
		.replace("{{VLLM_ARGS}}", vllmArgs.join(" "));

	// 通过 SSH 上传定制后的脚本到远程 Pod
	await sshExec(
		pod.ssh,
		`cat > /tmp/model_run_${name}.sh << 'EOF'
${scriptContent}
EOF
chmod +x /tmp/model_run_${name}.sh`,
	);

	// 准备环境变量列表
	const env = [
		`HF_TOKEN='${process.env.HF_TOKEN}'`,
		`PI_API_KEY='${process.env.PI_API_KEY}'`,
		`HF_HUB_ENABLE_HF_TRANSFER=1`,
		`VLLM_NO_USAGE_STATS=1`,
		`PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`,
		`FORCE_COLOR=1`,
		`TERM=xterm-256color`,
		// 单 GPU 时通过 CUDA_VISIBLE_DEVICES 指定设备
		...(gpus.length === 1 ? [`CUDA_VISIBLE_DEVICES=${gpus[0]}`] : []),
		// 添加模型配置中定义的额外环境变量
		...Object.entries(modelConfig?.env || {}).map(([k, v]) => `${k}='${v}'`),
	]
		.map((e) => `export ${e}`)
		.join("\n");

	// 在远程 Pod 上启动模型运行器
	// 使用 script 命令创建伪终端以保留颜色输出
	// 使用 setsid 创建新会话，确保进程在 SSH 断开后继续运行
	const startCmd = `
		${env}
		mkdir -p ~/.vllm_logs
		# 创建一个包装脚本来监控 script 命令的执行
		cat > /tmp/model_wrapper_${name}.sh << 'WRAPPER'
#!/bin/bash
script -q -f -c "/tmp/model_run_${name}.sh" ~/.vllm_logs/${name}.log
exit_code=$?
echo "Script exited with code $exit_code" >> ~/.vllm_logs/${name}.log
exit $exit_code
WRAPPER
		chmod +x /tmp/model_wrapper_${name}.sh
		setsid /tmp/model_wrapper_${name}.sh </dev/null >/dev/null 2>&1 &
		echo $!
		exit 0
	`;

	const pidResult = await sshExec(pod.ssh, startCmd);
	const pid = parseInt(pidResult.stdout.trim(), 10);
	if (!pid) {
		console.error(chalk.red("Failed to start model runner"));
		process.exit(1);
	}

	// 将模型信息保存到本地配置
	const config = loadConfig();
	config.pods[podName].models[name] = { model: modelId, port, gpu: gpus, pid };
	saveConfig(config);

	console.log(`Model runner started with PID: ${pid}`);
	console.log("Streaming logs... (waiting for startup)\n");

	// 短暂延迟等待日志文件创建
	await new Promise((resolve) => setTimeout(resolve, 500));

	// 通过 SSH tail -f 流式监控日志，检测启动状态
	const sshParts = pod.ssh.split(" ");
	const sshCommand = sshParts[0];
	const sshArgs = sshParts.slice(1);
	const host = sshArgs[0].split("@")[1] || "localhost";
	const tailCmd = `tail -f ~/.vllm_logs/${name}.log`;

	const fullArgs = [...sshArgs, tailCmd];

	const logProcess = spawn(sshCommand, fullArgs, {
		stdio: ["inherit", "pipe", "pipe"],
		env: { ...process.env, FORCE_COLOR: "1" },
	});

	let interrupted = false;
	let startupComplete = false;
	let startupFailed = false;
	let failureReason = "";

	// 处理 Ctrl+C 中断信号
	const sigintHandler = () => {
		interrupted = true;
		logProcess.kill();
	};
	process.on("SIGINT", sigintHandler);

	// 逐行处理日志输出，检测启动成功或失败
	const processOutput = (data: Buffer) => {
		const lines = data.toString().split("\n");
		for (const line of lines) {
			if (line) {
				console.log(line);

				// 检测 vLLM 启动完成标志
				if (line.includes("Application startup complete")) {
					startupComplete = true;
					logProcess.kill();
				}

				// 检测各种启动失败的情况
				if (line.includes("Model runner exiting with code") && !line.includes("code 0")) {
					startupFailed = true;
					failureReason = "Model runner failed to start";
					logProcess.kill();
				}
				if (line.includes("Script exited with code") && !line.includes("code 0")) {
					startupFailed = true;
					failureReason = "Script failed to execute";
					logProcess.kill();
				}
				if (line.includes("torch.OutOfMemoryError") || line.includes("CUDA out of memory")) {
					startupFailed = true;
					failureReason = "Out of GPU memory (OOM)";
					// OOM 错误不立即终止，等待更多上下文信息
				}
				if (line.includes("RuntimeError: Engine core initialization failed")) {
					startupFailed = true;
					failureReason = "vLLM engine initialization failed";
					logProcess.kill();
				}
			}
		}
	};

	logProcess.stdout?.on("data", processOutput);
	logProcess.stderr?.on("data", processOutput);

	await new Promise<void>((resolve) => logProcess.on("exit", resolve));
	process.removeListener("SIGINT", sigintHandler);

	if (startupFailed) {
		// 启动失败：清理配置并输出错误信息和建议
		console.log(`\n${chalk.red(`✗ Model failed to start: ${failureReason}`)}`);

		// 从配置中移除失败的模型
		const config = loadConfig();
		delete config.pods[podName].models[name];
		saveConfig(config);

		console.log(chalk.yellow("\nModel has been removed from configuration."));

		// 根据失败原因提供针对性建议
		if (failureReason.includes("OOM") || failureReason.includes("memory")) {
			console.log(`\n${chalk.bold("Suggestions:")}`);
			console.log("  • Try reducing GPU memory utilization: --memory 50%");
			console.log("  • Use a smaller context window: --context 4k");
			console.log("  • Use a quantized version of the model (e.g., FP8)");
			console.log("  • Use more GPUs with tensor parallelism");
			console.log("  • Try a smaller model variant");
		}

		console.log(`\n${chalk.cyan(`Check full logs: pi ssh "tail -100 ~/.vllm_logs/${name}.log"`)}`);
		process.exit(1);
	} else if (startupComplete) {
		// 启动成功：输出连接详情和使用示例
		console.log(`\n${chalk.green("✓ Model started successfully!")}`);
		console.log(`\n${chalk.bold("Connection Details:")}`);
		console.log(chalk.cyan("─".repeat(50)));
		console.log(chalk.white("Base URL:    ") + chalk.yellow(`http://${host}:${port}/v1`));
		console.log(chalk.white("Model:       ") + chalk.yellow(modelId));
		console.log(chalk.white("API Key:     ") + chalk.yellow(process.env.PI_API_KEY || "(not set)"));
		console.log(chalk.cyan("─".repeat(50)));

		console.log(`\n${chalk.bold("Export for shell:")}`);
		console.log(chalk.gray(`export OPENAI_BASE_URL="http://${host}:${port}/v1"`));
		console.log(chalk.gray(`export OPENAI_API_KEY="${process.env.PI_API_KEY || "your-api-key"}"`));
		console.log(chalk.gray(`export OPENAI_MODEL="${modelId}"`));

		console.log(`\n${chalk.bold("Example usage:")}`);
		console.log(
			chalk.gray(`
  # Python
  from openai import OpenAI
  client = OpenAI()  # Uses env vars
  response = client.chat.completions.create(
      model="${modelId}",
      messages=[{"role": "user", "content": "Hello!"}]
  )

  # CLI
  curl $OPENAI_BASE_URL/chat/completions \\
    -H "Authorization: Bearer $OPENAI_API_KEY" \\
    -H "Content-Type: application/json" \\
    -d '{"model":"${modelId}","messages":[{"role":"user","content":"Hi"}]}'`),
		);
		console.log("");
		console.log(chalk.cyan(`Chat with model:  pi agent ${name} "Your message"`));
		console.log(chalk.cyan(`Interactive mode: pi agent ${name} -i`));
		console.log(chalk.cyan(`Monitor logs:     pi logs ${name}`));
		console.log(chalk.cyan(`Stop model:       pi stop ${name}`));
	} else if (interrupted) {
		// 用户中断：模型仍在后台继续部署
		console.log(chalk.yellow("\n\nStopped monitoring. Model deployment continues in background."));
		console.log(chalk.cyan(`Chat with model: pi agent ${name} "Your message"`));
		console.log(chalk.cyan(`Check status: pi logs ${name}`));
		console.log(chalk.cyan(`Stop model: pi stop ${name}`));
	} else {
		// 日志流意外结束：模型可能仍在运行
		console.log(chalk.yellow("\n\nLog stream ended. Model may still be running."));
		console.log(chalk.cyan(`Chat with model: pi agent ${name} "Your message"`));
		console.log(chalk.cyan(`Check status: pi logs ${name}`));
		console.log(chalk.cyan(`Stop model: pi stop ${name}`));
	}
};

/**
 * 停止指定模型
 * 终止远程进程并从本地配置中移除模型信息
 * @param name - 模型别名
 * @param options - 可选的 Pod 覆盖参数
 */
export const stopModel = async (name: string, options: { pod?: string }) => {
	const { name: podName, pod } = getPod(options.pod);

	const model = pod.models[name];
	if (!model) {
		console.error(chalk.red(`Model '${name}' not found on pod '${podName}'`));
		process.exit(1);
	}

	console.log(chalk.yellow(`Stopping model '${name}' on pod '${podName}'...`));

	// 终止 script 进程及其所有子进程
	const killCmd = `
		# 先终止子进程，再终止主进程
		pkill -TERM -P ${model.pid} 2>/dev/null || true
		kill ${model.pid} 2>/dev/null || true
	`;
	await sshExec(pod.ssh, killCmd);

	// 从本地配置中移除模型
	const config = loadConfig();
	delete config.pods[podName].models[name];
	saveConfig(config);

	console.log(chalk.green(`✓ Model '${name}' stopped`));
};

/**
 * 停止 Pod 上的所有模型
 * 批量终止所有远程模型进程并清空本地模型配置
 * @param options - 可选的 Pod 覆盖参数
 */
export const stopAllModels = async (options: { pod?: string }) => {
	const { name: podName, pod } = getPod(options.pod);

	const modelNames = Object.keys(pod.models);
	if (modelNames.length === 0) {
		console.log(`No models running on pod '${podName}'`);
		return;
	}

	console.log(chalk.yellow(`Stopping ${modelNames.length} model(s) on pod '${podName}'...`));

	// 批量终止所有模型的进程树
	const pids = Object.values(pod.models).map((m) => m.pid);
	const killCmd = `
		for PID in ${pids.join(" ")}; do
			pkill -TERM -P $PID 2>/dev/null || true
			kill $PID 2>/dev/null || true
		done
	`;
	await sshExec(pod.ssh, killCmd);

	// 清空本地配置中的所有模型
	const config = loadConfig();
	config.pods[podName].models = {};
	saveConfig(config);

	console.log(chalk.green(`✓ Stopped all models: ${modelNames.join(", ")}`));
};

/**
 * 列出当前 Pod 上所有运行中的模型
 * 显示模型详情并通过 SSH 验证远程进程的实际运行状态
 * @param options - 可选的 Pod 覆盖参数
 */
export const listModels = async (options: { pod?: string }) => {
	const { name: podName, pod } = getPod(options.pod);

	const modelNames = Object.keys(pod.models);
	if (modelNames.length === 0) {
		console.log(`No models running on pod '${podName}'`);
		return;
	}

	// 从 SSH 命令中提取主机地址，用于显示 API URL
	const sshParts = pod.ssh.split(" ");
	const host = sshParts.find((p) => p.includes("@"))?.split("@")[1] || "unknown";

	console.log(`Models on pod '${chalk.bold(podName)}':`);
	for (const name of modelNames) {
		const model = pod.models[name];
		const gpuStr =
			model.gpu.length > 1
				? `GPUs ${model.gpu.join(",")}`
				: model.gpu.length === 1
					? `GPU ${model.gpu[0]}`
					: "GPU unknown";
		console.log(`  ${chalk.green(name)} - Port ${model.port} - ${gpuStr} - PID ${model.pid}`);
		console.log(`    Model: ${chalk.gray(model.model)}`);
		console.log(`    URL: ${chalk.cyan(`http://${host}:${model.port}/v1`)}`);
	}

	// 通过 SSH 验证远程进程的实际状态
	console.log("");
	console.log("Verifying processes...");
	let anyDead = false;
	for (const name of modelNames) {
		const model = pod.models[name];
		// 检查包装进程是否存在，以及 vLLM 健康检查端点是否响应
		const checkCmd = `
			# 检查包装进程是否存在
			if ps -p ${model.pid} > /dev/null 2>&1; then
				# 进程存在，检查 vLLM 是否正常响应
				if curl -s -f http://localhost:${model.port}/health > /dev/null 2>&1; then
					echo "running"
				else
					# 检查日志中是否有错误信息，判断是崩溃还是仍在启动中
					if tail -n 20 ~/.vllm_logs/${name}.log 2>/dev/null | grep -q "ERROR\\|Failed\\|Cuda error\\|died"; then
						echo "crashed"
					else
						echo "starting"
					fi
				fi
			else
				echo "dead"
			fi
		`;
		const result = await sshExec(pod.ssh, checkCmd);
		const status = result.stdout.trim();
		if (status === "dead") {
			console.log(chalk.red(`  ${name}: Process ${model.pid} is not running`));
			anyDead = true;
		} else if (status === "crashed") {
			console.log(chalk.red(`  ${name}: vLLM crashed (check logs with 'pi logs ${name}')`));
			anyDead = true;
		} else if (status === "starting") {
			console.log(chalk.yellow(`  ${name}: Still starting up...`));
		}
	}

	if (anyDead) {
		console.log("");
		console.log(chalk.yellow("Some models are not running. Clean up with:"));
		console.log(chalk.cyan("  pi stop <name>"));
	} else {
		console.log(chalk.green("✓ All processes verified"));
	}
};

/**
 * 流式查看模型日志
 * 通过 SSH tail -f 实时输出指定模型的运行日志
 * @param name - 模型别名
 * @param options - 可选的 Pod 覆盖参数
 */
export const viewLogs = async (name: string, options: { pod?: string }) => {
	const { name: podName, pod } = getPod(options.pod);

	const model = pod.models[name];
	if (!model) {
		console.error(chalk.red(`Model '${name}' not found on pod '${podName}'`));
		process.exit(1);
	}

	console.log(chalk.green(`Streaming logs for '${name}' on pod '${podName}'...`));
	console.log(chalk.gray("Press Ctrl+C to stop"));
	console.log("");

	// 通过 SSH 流式传输日志，保留颜色输出
	const sshParts = pod.ssh.split(" ");
	const sshCommand = sshParts[0];
	const sshArgs = sshParts.slice(1);
	const tailCmd = `tail -f ~/.vllm_logs/${name}.log`;

	const logProcess = spawn(sshCommand, [...sshArgs, tailCmd], {
		stdio: "inherit",
		env: {
			...process.env,
			FORCE_COLOR: "1",
		},
	});

	// 等待日志进程退出（通常是用户按 Ctrl+C）
	await new Promise<void>((resolve) => {
		logProcess.on("exit", () => resolve());
	});
};

/**
 * 显示所有已知的预定义模型及其硬件兼容性
 *
 * 功能：
 * - 如果有活跃 Pod，按兼容性分组显示（兼容/不兼容）
 * - 如果没有活跃 Pod，显示所有模型及其最低硬件要求
 * - 显示每个模型的 GPU 配置、名称和备注信息
 */
export const showKnownModels = async () => {
	const __filename = fileURLToPath(import.meta.url);
	const __dirname = dirname(__filename);
	const modelsJsonPath = join(__dirname, "..", "models.json");
	const modelsJson = JSON.parse(readFileSync(modelsJsonPath, "utf-8"));
	const models = modelsJson.models;

	// 获取活跃 Pod 信息，用于兼容性检查
	const activePod = getActivePod();
	let podGpuCount = 0;
	let podGpuType = "";

	if (activePod) {
		podGpuCount = activePod.pod.gpus.length;
		// 从 GPU 名称中提取型号（如 "NVIDIA H200" -> "H200"）
		podGpuType = activePod.pod.gpus[0]?.name?.replace("NVIDIA", "")?.trim()?.split(" ")[0] || "";

		console.log(chalk.bold(`Known Models for ${activePod.name} (${podGpuCount}x ${podGpuType || "GPU"}):\n`));
	} else {
		console.log(chalk.bold("Known Models:\n"));
		console.log(chalk.yellow("No active pod. Use 'pi pods active <name>' to filter compatible models.\n"));
	}

	console.log("Usage: pi start <model> --name <name> [options]\n");

	// 按模型系列分组，区分兼容和不兼容的模型
	const compatible: Record<string, Array<{ id: string; name: string; config: string; notes?: string }>> = {};
	const incompatible: Record<string, Array<{ id: string; name: string; minGpu: string; notes?: string }>> = {};

	for (const [modelId, info] of Object.entries(models)) {
		const modelInfo = info as any;
		// 按模型名称的第一个短横线前的部分进行分组（如 "Llama-3" -> "Llama"）
		const family = modelInfo.name.split("-")[0] || "Other";

		let isCompatible = false;
		let compatibleConfig = "";
		let minGpu = "Unknown";
		let minNotes: string | undefined;

		if (modelInfo.configs && modelInfo.configs.length > 0) {
			// 按 GPU 数量排序，找到最低硬件要求
			const sortedConfigs = [...modelInfo.configs].sort((a: any, b: any) => (a.gpuCount || 1) - (b.gpuCount || 1));

			// 获取最低硬件要求信息
			const minConfig = sortedConfigs[0];
			const minGpuCount = minConfig.gpuCount || 1;
			const gpuTypes = minConfig.gpuTypes?.join("/") || "H100/H200";

			if (minGpuCount === 1) {
				minGpu = `1x ${gpuTypes}`;
			} else {
				minGpu = `${minGpuCount}x ${gpuTypes}`;
			}

			minNotes = minConfig.notes || modelInfo.notes;

			// 检查与当前活跃 Pod 的兼容性
			if (activePod && podGpuCount > 0) {
				for (const config of sortedConfigs) {
					const configGpuCount = config.gpuCount || 1;
					const configGpuTypes = config.gpuTypes || [];

					// 检查 GPU 数量是否足够
					if (configGpuCount <= podGpuCount) {
						// 检查 GPU 类型是否匹配
						if (
							configGpuTypes.length === 0 ||
							configGpuTypes.some((type: string) => podGpuType.includes(type) || type.includes(podGpuType))
						) {
							isCompatible = true;
							if (configGpuCount === 1) {
								compatibleConfig = `1x ${podGpuType}`;
							} else {
								compatibleConfig = `${configGpuCount}x ${podGpuType}`;
							}
							minNotes = config.notes || modelInfo.notes;
							break;
						}
					}
				}
			}
		}

		const modelEntry = {
			id: modelId,
			name: modelInfo.name,
			notes: minNotes,
		};

		// 根据兼容性分类
		if (activePod && isCompatible) {
			if (!compatible[family]) {
				compatible[family] = [];
			}
			compatible[family].push({ ...modelEntry, config: compatibleConfig });
		} else {
			if (!incompatible[family]) {
				incompatible[family] = [];
			}
			incompatible[family].push({ ...modelEntry, minGpu });
		}
	}

	// 优先显示兼容的模型
	if (activePod && Object.keys(compatible).length > 0) {
		console.log(chalk.green.bold("✓ Compatible Models:\n"));

		const sortedFamilies = Object.keys(compatible).sort();
		for (const family of sortedFamilies) {
			console.log(chalk.cyan(`${family} Models:`));

			const modelList = compatible[family].sort((a, b) => a.name.localeCompare(b.name));

			for (const model of modelList) {
				console.log(`  ${chalk.green(model.id)}`);
				console.log(`    Name: ${model.name}`);
				console.log(`    Config: ${model.config}`);
				if (model.notes) {
					console.log(chalk.gray(`    Note: ${model.notes}`));
				}
				console.log("");
			}
		}
	}

	// 显示不兼容的模型
	if (Object.keys(incompatible).length > 0) {
		if (activePod && Object.keys(compatible).length > 0) {
			console.log(chalk.red.bold("✗ Incompatible Models (need more/different GPUs):\n"));
		}

		const sortedFamilies = Object.keys(incompatible).sort();
		for (const family of sortedFamilies) {
			if (!activePod) {
				console.log(chalk.cyan(`${family} Models:`));
			} else {
				console.log(chalk.gray(`${family} Models:`));
			}

			const modelList = incompatible[family].sort((a, b) => a.name.localeCompare(b.name));

			for (const model of modelList) {
				const color = activePod ? chalk.gray : chalk.green;
				console.log(`  ${color(model.id)}`);
				console.log(chalk.gray(`    Name: ${model.name}`));
				console.log(chalk.gray(`    Min Hardware: ${model.minGpu}`));
				if (model.notes && !activePod) {
					console.log(chalk.gray(`    Note: ${model.notes}`));
				}
				if (activePod) {
					console.log("");
				} else {
					console.log("");
				}
			}
		}
	}

	console.log(chalk.gray("\nFor unknown models, defaults to single GPU deployment."));
	console.log(chalk.gray("Use --vllm to pass custom arguments to vLLM."));
};
