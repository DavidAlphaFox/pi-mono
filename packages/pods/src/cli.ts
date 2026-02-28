#!/usr/bin/env node
/**
 * @file CLI 入口文件 - GPU Pod 管理工具的主命令行界面
 *
 * 本文件是 `pi` CLI 工具的入口点，负责：
 * - 解析命令行参数并分发到对应的子命令处理器
 * - 管理 Pod（setup、list、active、remove）
 * - 管理模型（start、stop、list、logs）
 * - 提供 SSH/Shell 连接功能
 * - 提供 Agent 交互式聊天功能
 */
import chalk from "chalk";
import { spawn } from "child_process";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { listModels, showKnownModels, startModel, stopAllModels, stopModel, viewLogs } from "./commands/models.js";
import { listPods, removePodCommand, setupPod, switchActivePod } from "./commands/pods.js";
import { promptModel } from "./commands/prompt.js";
import { getActivePod, loadConfig } from "./config.js";
import { sshExecStream } from "./ssh.js";

/** 当前文件的绝对路径 */
const __filename = fileURLToPath(import.meta.url);
/** 当前文件所在目录的绝对路径 */
const __dirname = dirname(__filename);

/** 从 package.json 中读取版本信息 */
const packageJson = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8"));

/**
 * 打印帮助信息
 * 显示所有可用命令及其用法说明
 */
function printHelp() {
	console.log(`pi v${packageJson.version} - Manage vLLM deployments on GPU pods

Pod Management:
  pi pods setup <name> "<ssh>" --mount "<mount>"    Setup pod with mount command
    Options:
      --vllm release    Install latest vLLM release >=0.10.0 (default)
      --vllm nightly    Install vLLM nightly build (latest features)
      --vllm gpt-oss    Install vLLM 0.10.1+gptoss with PyTorch nightly (GPT-OSS only)
  pi pods                                           List all pods (* = active)
  pi pods active <name>                             Switch active pod
  pi pods remove <name>                             Remove pod from local config
  pi shell [<name>]                                 Open shell on pod (active or specified)
  pi ssh [<name>] "<command>"                       Run SSH command on pod

Model Management:
  pi start <model> --name <name> [options]          Start a model
    --memory <percent>   GPU memory allocation (30%, 50%, 90%)
    --context <size>     Context window (4k, 8k, 16k, 32k, 64k, 128k)
    --gpus <count>       Number of GPUs to use (predefined models only)
    --vllm <args...>     Pass remaining args to vLLM (ignores other options)
  pi stop [<name>]                                  Stop model (or all if no name)
  pi list                                           List running models
  pi logs <name>                                    Stream model logs
  pi agent <name> ["<message>"...] [options]        Chat with model using agent & tools
  pi agent <name> [options]                         Interactive chat mode
    --continue, -c       Continue previous session
    --json              Output as JSONL
    (All pi-agent options are supported)

  All model commands support --pod <name> to override the active pod.

Environment:
  HF_TOKEN         HuggingFace token for model downloads
  PI_API_KEY     API key for vLLM endpoints
  PI_CONFIG_DIR    Config directory (default: ~/.pi)`);
}

// 解析命令行参数，去掉 node 和脚本路径
const args = process.argv.slice(2);

// 无参数或请求帮助时，显示帮助信息并退出
if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
	printHelp();
	process.exit(0);
}

// 显示版本号
if (args[0] === "--version" || args[0] === "-v") {
	console.log(packageJson.version);
	process.exit(0);
}

/** 主命令（如 pods、start、stop 等） */
const command = args[0];
/** 子命令（如 setup、active、remove 等） */
const subcommand = args[1];

// 主命令处理逻辑
try {
	// 处理 "pi pods" 相关的 Pod 管理命令
	if (command === "pods") {
		if (!subcommand) {
			// pi pods - 列出所有已配置的 Pod
			listPods();
		} else if (subcommand === "setup") {
			// pi pods setup <name> "<ssh>" - 初始化配置一个新的 Pod
			const name = args[2];
			const sshCmd = args[3];

			if (!name || !sshCmd) {
				console.error(
					'Usage: pi pods setup <name> "<ssh>" [--mount "<mount>"] [--models-path <path>] [--vllm release|nightly|gpt-oss]',
				);
				process.exit(1);
			}

			// 解析可选参数：挂载命令、模型路径、vLLM 版本
			const options: { mount?: string; modelsPath?: string; vllm?: "release" | "nightly" | "gpt-oss" } = {};
			for (let i = 4; i < args.length; i++) {
				if (args[i] === "--mount" && i + 1 < args.length) {
					options.mount = args[i + 1];
					i++;
				} else if (args[i] === "--models-path" && i + 1 < args.length) {
					options.modelsPath = args[i + 1];
					i++;
				} else if (args[i] === "--vllm" && i + 1 < args.length) {
					const vllmType = args[i + 1];
					if (vllmType === "release" || vllmType === "nightly" || vllmType === "gpt-oss") {
						options.vllm = vllmType;
					} else {
						console.error(chalk.red(`Invalid vLLM type: ${vllmType}`));
						console.error("Valid options: release, nightly, gpt-oss");
						process.exit(1);
					}
					i++;
				}
			}

			// 如果提供了 --mount 但没有 --models-path，尝试从挂载命令中提取路径
			if (options.mount && !options.modelsPath) {
				// 提取挂载命令的最后一部分作为模型路径
				const parts = options.mount.trim().split(" ");
				const lastPart = parts[parts.length - 1];
				if (lastPart?.startsWith("/")) {
					options.modelsPath = lastPart;
				}
			}

			await setupPod(name, sshCmd, options);
		} else if (subcommand === "active") {
			// pi pods active <name> - 切换当前活跃 Pod
			const name = args[2];
			if (!name) {
				console.error("Usage: pi pods active <name>");
				process.exit(1);
			}
			switchActivePod(name);
		} else if (subcommand === "remove") {
			// pi pods remove <name> - 从本地配置中移除 Pod
			const name = args[2];
			if (!name) {
				console.error("Usage: pi pods remove <name>");
				process.exit(1);
			}
			removePodCommand(name);
		} else {
			console.error(`Unknown pods subcommand: ${subcommand}`);
			process.exit(1);
		}
	} else {
		// 解析 --pod 参数，用于覆盖默认的活跃 Pod
		let podOverride: string | undefined;
		const podIndex = args.indexOf("--pod");
		if (podIndex !== -1 && podIndex + 1 < args.length) {
			podOverride = args[podIndex + 1];
			// 从参数列表中移除 --pod 及其值
			args.splice(podIndex, 2);
		}

		// 处理 SSH/Shell 命令和模型管理命令
		switch (command) {
			case "shell": {
				// pi shell [<name>] - 打开 Pod 的交互式 Shell
				const podName = args[1];
				let podInfo: { name: string; pod: import("./types.js").Pod } | null = null;

				// 如果指定了 Pod 名称则使用指定的，否则使用活跃 Pod
				if (podName) {
					const config = loadConfig();
					const pod = config.pods[podName];
					if (pod) {
						podInfo = { name: podName, pod };
					}
				} else {
					podInfo = getActivePod();
				}

				if (!podInfo) {
					if (podName) {
						console.error(chalk.red(`Pod '${podName}' not found`));
					} else {
						console.error(chalk.red("No active pod. Use 'pi pods active <name>' to set one."));
					}
					process.exit(1);
				}

				console.log(chalk.green(`Connecting to pod '${podInfo.name}'...`));

				// 以交互模式启动 SSH 连接
				const sshArgs = podInfo.pod.ssh.split(" ").slice(1); // 去掉 'ssh' 命令本身
				const sshProcess = spawn("ssh", sshArgs, {
					stdio: "inherit",
					env: process.env,
				});

				sshProcess.on("exit", (code) => {
					process.exit(code || 0);
				});
				break;
			}
			case "ssh": {
				// pi ssh [<name>] "<command>" - 在 Pod 上远程执行命令
				let podName: string | undefined;
				let sshCommand: string;

				if (args.length === 2) {
					// pi ssh "<command>" - 在活跃 Pod 上执行
					sshCommand = args[1];
				} else if (args.length === 3) {
					// pi ssh <name> "<command>" - 在指定 Pod 上执行
					podName = args[1];
					sshCommand = args[2];
				} else {
					console.error('Usage: pi ssh [<name>] "<command>"');
					process.exit(1);
				}

				let podInfo: { name: string; pod: import("./types.js").Pod } | null = null;

				if (podName) {
					const config = loadConfig();
					const pod = config.pods[podName];
					if (pod) {
						podInfo = { name: podName, pod };
					}
				} else {
					podInfo = getActivePod();
				}

				if (!podInfo) {
					if (podName) {
						console.error(chalk.red(`Pod '${podName}' not found`));
					} else {
						console.error(chalk.red("No active pod. Use 'pi pods active <name>' to set one."));
					}
					process.exit(1);
				}

				console.log(chalk.gray(`Running on pod '${podInfo.name}': ${sshCommand}`));

				// 执行命令并将输出流式传输到控制台
				const exitCode = await sshExecStream(podInfo.pod.ssh, sshCommand);
				process.exit(exitCode);
				break;
			}
			case "start": {
				// pi start <model> --name <name> [options] - 启动模型
				const modelId = args[1];
				if (!modelId) {
					// 未指定模型时，显示可用模型列表
					await showKnownModels();
					process.exit(0);
				}

				// 解析模型启动选项
				let name: string | undefined;
				let memory: string | undefined;
				let context: string | undefined;
				let gpus: number | undefined;
				const vllmArgs: string[] = [];
				let inVllmArgs = false; // 标记是否进入 --vllm 自定义参数模式

				for (let i = 2; i < args.length; i++) {
					if (inVllmArgs) {
						// --vllm 之后的所有参数都直接传递给 vLLM
						vllmArgs.push(args[i]);
					} else if (args[i] === "--name" && i + 1 < args.length) {
						name = args[i + 1];
						i++;
					} else if (args[i] === "--memory" && i + 1 < args.length) {
						memory = args[i + 1];
						i++;
					} else if (args[i] === "--context" && i + 1 < args.length) {
						context = args[i + 1];
						i++;
					} else if (args[i] === "--gpus" && i + 1 < args.length) {
						gpus = parseInt(args[i + 1], 10);
						if (Number.isNaN(gpus) || gpus < 1) {
							console.error(chalk.red("--gpus must be a positive number"));
							process.exit(1);
						}
						i++;
					} else if (args[i] === "--vllm") {
						inVllmArgs = true;
					}
				}

				if (!name) {
					console.error("--name is required");
					process.exit(1);
				}

				// 当 --vllm 与其他参数同时使用时发出警告
				if (vllmArgs.length > 0 && (memory || context || gpus)) {
					console.log(
						chalk.yellow("⚠ Warning: --memory, --context, and --gpus are ignored when --vllm is specified"),
					);
					console.log(chalk.yellow("  Using only custom vLLM arguments"));
					console.log("");
				}

				await startModel(modelId, name, {
					pod: podOverride,
					memory,
					context,
					gpus,
					vllmArgs: vllmArgs.length > 0 ? vllmArgs : undefined,
				});
				break;
			}
			case "stop": {
				// pi stop [name] - 停止指定模型，或不指定名称时停止所有模型
				const name = args[1];
				if (!name) {
					await stopAllModels({ pod: podOverride });
				} else {
					await stopModel(name, { pod: podOverride });
				}
				break;
			}
			case "list":
				// pi list - 列出当前 Pod 上运行中的所有模型
				await listModels({ pod: podOverride });
				break;
			case "logs": {
				// pi logs <name> - 流式查看指定模型的日志
				const name = args[1];
				if (!name) {
					console.error("Usage: pi logs <name>");
					process.exit(1);
				}
				await viewLogs(name, { pod: podOverride });
				break;
			}
			case "agent": {
				// pi agent <name> [messages...] [options] - 使用 Agent 与模型进行对话
				const name = args[1];
				if (!name) {
					console.error("Usage: pi agent <name> [messages...] [options]");
					process.exit(1);
				}

				const apiKey = process.env.PI_API_KEY;

				// 将模型名称之后的所有参数传递给 Agent
				const agentArgs = args.slice(2);

				// 调用 Agent 进行交互（无消息参数时进入交互式模式）
				await promptModel(name, agentArgs, {
					pod: podOverride,
					apiKey,
				}).catch(() => {
					// 错误已在 promptModel 中处理，此处直接退出
					process.exit(0);
				});
				break;
			}
			default:
				console.error(`Unknown command: ${command}`);
				printHelp();
				process.exit(1);
		}
	}
} catch (error) {
	console.error("Error:", error);
	process.exit(1);
}
