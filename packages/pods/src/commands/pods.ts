/**
 * @file Pod 管理命令模块
 *
 * 本文件实现了 GPU Pod 生命周期管理的所有命令，包括：
 * - 列出所有已配置的 Pod（listPods）
 * - 初始化配置新的 Pod（setupPod）：SSH 连接测试、脚本上传、环境安装、GPU 检测
 * - 切换活跃 Pod（switchActivePod）
 * - 从本地配置中移除 Pod（removePodCommand）
 */
import chalk from "chalk";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { addPod, loadConfig, removePod, setActivePod } from "../config.js";
import { scpFile, sshExec, sshExecStream } from "../ssh.js";
import type { GPU, Pod } from "../types.js";

/** 当前文件的绝对路径 */
const __filename = fileURLToPath(import.meta.url);
/** 当前文件所在目录的绝对路径 */
const __dirname = dirname(__filename);

/**
 * 列出所有已配置的 Pod
 * 显示每个 Pod 的名称、GPU 信息、vLLM 版本、SSH 连接和模型路径
 * 活跃 Pod 用绿色星号标记
 */
export const listPods = () => {
	const config = loadConfig();
	const podNames = Object.keys(config.pods);

	if (podNames.length === 0) {
		console.log("No pods configured. Use 'pi pods setup' to add a pod.");
		return;
	}

	console.log("Configured pods:");
	for (const name of podNames) {
		const pod = config.pods[name];
		const isActive = config.active === name;
		const marker = isActive ? chalk.green("*") : " ";
		const gpuCount = pod.gpus?.length || 0;
		const gpuInfo = gpuCount > 0 ? `${gpuCount}x ${pod.gpus[0].name}` : "no GPUs detected";
		const vllmInfo = pod.vllmVersion ? ` (vLLM: ${pod.vllmVersion})` : "";
		console.log(`${marker} ${chalk.bold(name)} - ${gpuInfo}${vllmInfo} - ${pod.ssh}`);
		if (pod.modelsPath) {
			console.log(`    Models: ${pod.modelsPath}`);
		}
		if (pod.vllmVersion === "gpt-oss") {
			console.log(chalk.yellow(`    ⚠️  GPT-OSS build - only for GPT-OSS models`));
		}
	}
};

/**
 * 初始化配置一个新的 GPU Pod
 *
 * 执行步骤：
 * 1. 验证必需的环境变量（HF_TOKEN、PI_API_KEY）
 * 2. 测试 SSH 连接
 * 3. 通过 SCP 上传安装脚本到远程 Pod
 * 4. 执行安装脚本（安装 vLLM、配置环境等，耗时 2-5 分钟）
 * 5. 通过 nvidia-smi 检测 GPU 硬件配置
 * 6. 保存 Pod 配置到本地
 *
 * @param name - Pod 名称（用户自定义的标识符）
 * @param sshCmd - SSH 连接命令（如 "ssh root@1.2.3.4"）
 * @param options - 配置选项
 * @param options.mount - NFS 挂载命令
 * @param options.modelsPath - 模型文件存储路径
 * @param options.vllm - vLLM 版本类型（release/nightly/gpt-oss）
 */
export const setupPod = async (
	name: string,
	sshCmd: string,
	options: { mount?: string; modelsPath?: string; vllm?: "release" | "nightly" | "gpt-oss" },
) => {
	// 验证必需的环境变量
	const hfToken = process.env.HF_TOKEN;
	const vllmApiKey = process.env.PI_API_KEY;

	if (!hfToken) {
		console.error(chalk.red("ERROR: HF_TOKEN environment variable is required"));
		console.error("Get a token from: https://huggingface.co/settings/tokens");
		console.error("Then run: export HF_TOKEN=your_token_here");
		process.exit(1);
	}

	if (!vllmApiKey) {
		console.error(chalk.red("ERROR: PI_API_KEY environment variable is required"));
		console.error("Set an API key: export PI_API_KEY=your_api_key_here");
		process.exit(1);
	}

	// 确定模型存储路径：优先使用显式指定，否则从挂载命令中提取
	let modelsPath = options.modelsPath;
	if (!modelsPath && options.mount) {
		// 从挂载命令中提取路径（如 "mount -t nfs ... /mnt/sfs" -> "/mnt/sfs"）
		const parts = options.mount.split(" ");
		modelsPath = parts[parts.length - 1];
	}

	if (!modelsPath) {
		console.error(chalk.red("ERROR: --models-path is required (or must be extractable from --mount)"));
		process.exit(1);
	}

	console.log(chalk.green(`Setting up pod '${name}'...`));
	console.log(`SSH: ${sshCmd}`);
	console.log(`Models path: ${modelsPath}`);
	console.log(
		`vLLM version: ${options.vllm || "release"} ${options.vllm === "gpt-oss" ? chalk.yellow("(GPT-OSS special build)") : ""}`,
	);
	if (options.mount) {
		console.log(`Mount command: ${options.mount}`);
	}
	console.log("");

	// 第一步：测试 SSH 连接
	console.log("Testing SSH connection...");
	const testResult = await sshExec(sshCmd, "echo 'SSH OK'");
	if (testResult.exitCode !== 0) {
		console.error(chalk.red("Failed to connect via SSH"));
		console.error(testResult.stderr);
		process.exit(1);
	}
	console.log(chalk.green("✓ SSH connection successful"));

	// 第二步：通过 SCP 上传安装脚本
	console.log("Copying setup script...");
	const scriptPath = join(__dirname, "../../scripts/pod_setup.sh");
	const success = await scpFile(sshCmd, scriptPath, "/tmp/pod_setup.sh");
	if (!success) {
		console.error(chalk.red("Failed to copy setup script"));
		process.exit(1);
	}
	console.log(chalk.green("✓ Setup script copied"));

	// 第三步：构建并执行安装命令
	let setupCmd = `bash /tmp/pod_setup.sh --models-path '${modelsPath}' --hf-token '${hfToken}' --vllm-api-key '${vllmApiKey}'`;
	if (options.mount) {
		setupCmd += ` --mount '${options.mount}'`;
	}
	const vllmVersion = options.vllm || "release";
	setupCmd += ` --vllm '${vllmVersion}'`;

	console.log("");
	console.log(chalk.yellow("Running setup (this will take 2-5 minutes)..."));
	console.log("");

	// 使用 forceTTY 保留安装过程中 apt、pip 等命令的颜色输出
	const exitCode = await sshExecStream(sshCmd, setupCmd, { forceTTY: true });
	if (exitCode !== 0) {
		console.error(chalk.red("\nSetup failed. Check the output above for errors."));
		process.exit(1);
	}

	// 第四步：检测 GPU 硬件配置
	console.log("");
	console.log("Detecting GPU configuration...");
	const gpuResult = await sshExec(sshCmd, "nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader");

	const gpus: GPU[] = [];
	if (gpuResult.exitCode === 0 && gpuResult.stdout) {
		// 解析 nvidia-smi 输出，格式为 "0, NVIDIA H200, 80 GiB"
		const lines = gpuResult.stdout.trim().split("\n");
		for (const line of lines) {
			const [id, name, memory] = line.split(",").map((s) => s.trim());
			if (id !== undefined) {
				gpus.push({
					id: parseInt(id, 10),
					name: name || "Unknown",
					memory: memory || "Unknown",
				});
			}
		}
	}

	console.log(chalk.green(`✓ Detected ${gpus.length} GPU(s)`));
	for (const gpu of gpus) {
		console.log(`  GPU ${gpu.id}: ${gpu.name} (${gpu.memory})`);
	}

	// 第五步：保存 Pod 配置到本地
	const pod: Pod = {
		ssh: sshCmd,
		gpus,
		models: {},
		modelsPath,
		vllmVersion: options.vllm || "release",
	};

	addPod(name, pod);
	console.log("");
	console.log(chalk.green(`✓ Pod '${name}' setup complete and set as active pod`));
	console.log("");
	console.log("You can now deploy models with:");
	console.log(chalk.cyan(`  pi start <model> --name <name>`));
};

/**
 * 切换当前活跃的 Pod
 * @param name - 要切换到的 Pod 名称
 */
export const switchActivePod = (name: string) => {
	const config = loadConfig();
	if (!config.pods[name]) {
		console.error(chalk.red(`Pod '${name}' not found`));
		console.log("\nAvailable pods:");
		for (const podName of Object.keys(config.pods)) {
			console.log(`  ${podName}`);
		}
		process.exit(1);
	}

	setActivePod(name);
	console.log(chalk.green(`✓ Switched active pod to '${name}'`));
};

/**
 * 从本地配置中移除一个 Pod
 * 注意：仅移除本地配置，不会影响远程 Pod 的实际状态
 * @param name - 要移除的 Pod 名称
 */
export const removePodCommand = (name: string) => {
	const config = loadConfig();
	if (!config.pods[name]) {
		console.error(chalk.red(`Pod '${name}' not found`));
		process.exit(1);
	}

	removePod(name);
	console.log(chalk.green(`✓ Removed pod '${name}' from configuration`));
	console.log(chalk.yellow("Note: This only removes the local configuration. The remote pod is not affected."));
};
