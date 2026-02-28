/**
 * @file sandbox.ts - 沙盒执行环境模块
 *
 * 本文件负责：
 * 1. 定义沙盒配置类型（host 直接运行或 docker 容器运行）
 * 2. 解析命令行沙盒参数（--sandbox=host|docker:<name>）
 * 3. 验证沙盒环境（Docker 是否安装、容器是否运行）
 * 4. 提供 Executor 接口及其两种实现：
 *    - HostExecutor: 在宿主机上直接执行命令
 *    - DockerExecutor: 在 Docker 容器内执行命令
 * 5. 支持命令超时和中止信号处理
 */

import { spawn } from "child_process";

/**
 * 沙盒配置类型
 * - host: 直接在宿主机上运行命令
 * - docker: 在指定的 Docker 容器中运行命令
 */
export type SandboxConfig = { type: "host" } | { type: "docker"; container: string };

/**
 * 解析沙盒参数字符串
 * @param value - 参数值（"host" 或 "docker:<container-name>"）
 * @returns 沙盒配置对象
 */
export function parseSandboxArg(value: string): SandboxConfig {
	if (value === "host") {
		return { type: "host" };
	}
	if (value.startsWith("docker:")) {
		const container = value.slice("docker:".length);
		if (!container) {
			console.error("Error: docker sandbox requires container name (e.g., docker:mom-sandbox)");
			process.exit(1);
		}
		return { type: "docker", container };
	}
	console.error(`Error: Invalid sandbox type '${value}'. Use 'host' or 'docker:<container-name>'`);
	process.exit(1);
}

/**
 * 验证沙盒环境是否可用
 * host 模式无需验证，docker 模式检查 Docker 是否安装且容器是否运行
 * @param config - 沙盒配置
 */
export async function validateSandbox(config: SandboxConfig): Promise<void> {
	if (config.type === "host") {
		return;
	}

	// 检查 Docker 是否已安装
	try {
		await execSimple("docker", ["--version"]);
	} catch {
		console.error("Error: Docker is not installed or not in PATH");
		process.exit(1);
	}

	// 检查容器是否存在且正在运行
	try {
		const result = await execSimple("docker", ["inspect", "-f", "{{.State.Running}}", config.container]);
		if (result.trim() !== "true") {
			console.error(`Error: Container '${config.container}' is not running.`);
			console.error(`Start it with: docker start ${config.container}`);
			process.exit(1);
		}
	} catch {
		console.error(`Error: Container '${config.container}' does not exist.`);
		console.error("Create it with: ./docker.sh create <data-dir>");
		process.exit(1);
	}

	console.log(`  Docker container '${config.container}' is running.`);
}

/**
 * 执行简单命令并返回 stdout
 * 用于验证环境时的辅助函数
 * @param cmd - 命令名称
 * @param args - 命令参数
 * @returns stdout 输出
 * @throws 命令执行失败时抛出错误
 */
function execSimple(cmd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (d) => {
			stdout += d;
		});
		child.stderr?.on("data", (d) => {
			stderr += d;
		});
		child.on("close", (code) => {
			if (code === 0) resolve(stdout);
			else reject(new Error(stderr || `Exit code ${code}`));
		});
	});
}

/**
 * 根据沙盒配置创建对应的命令执行器
 * @param config - 沙盒配置
 * @returns Executor 实例
 */
export function createExecutor(config: SandboxConfig): Executor {
	if (config.type === "host") {
		return new HostExecutor();
	}
	return new DockerExecutor(config.container);
}

/**
 * 命令执行器接口
 * 定义了在不同沙盒环境中执行命令的标准方法
 */
export interface Executor {
	/**
	 * 执行 bash 命令
	 * @param command - 要执行的命令字符串
	 * @param options - 执行选项（超时、中止信号）
	 * @returns 执行结果（stdout、stderr、退出码）
	 */
	exec(command: string, options?: ExecOptions): Promise<ExecResult>;

	/**
	 * 获取工作区路径前缀
	 * Host 模式返回实际路径，Docker 模式返回 /workspace
	 * @param hostPath - 宿主机上的路径
	 * @returns 对应环境中的路径
	 */
	getWorkspacePath(hostPath: string): string;
}

/**
 * 命令执行选项
 */
export interface ExecOptions {
	/** 超时时间（秒） */
	timeout?: number;
	/** 中止信号 */
	signal?: AbortSignal;
}

/**
 * 命令执行结果
 */
export interface ExecResult {
	/** 标准输出 */
	stdout: string;
	/** 标准错误 */
	stderr: string;
	/** 退出码 */
	code: number;
}

/**
 * 宿主机执行器
 * 直接在宿主机上通过 sh -c 执行命令
 */
class HostExecutor implements Executor {
	/**
	 * 在宿主机上执行命令
	 * 支持超时和中止信号，输出限制为 10MB
	 */
	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		return new Promise((resolve, reject) => {
			const shell = process.platform === "win32" ? "cmd" : "sh";
			const shellArgs = process.platform === "win32" ? ["/c"] : ["-c"];

			// 使用 detached 模式创建进程，便于按进程组终止
			const child = spawn(shell, [...shellArgs, command], {
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";
			let timedOut = false;

			// 设置超时定时器
			const timeoutHandle =
				options?.timeout && options.timeout > 0
					? setTimeout(() => {
							timedOut = true;
							killProcessTree(child.pid!);
						}, options.timeout * 1000)
					: undefined;

			// 中止信号处理
			const onAbort = () => {
				if (child.pid) killProcessTree(child.pid);
			};

			if (options?.signal) {
				if (options.signal.aborted) {
					onAbort();
				} else {
					options.signal.addEventListener("abort", onAbort, { once: true });
				}
			}

			// 收集 stdout（限制 10MB 防止内存溢出）
			child.stdout?.on("data", (data) => {
				stdout += data.toString();
				if (stdout.length > 10 * 1024 * 1024) {
					stdout = stdout.slice(0, 10 * 1024 * 1024);
				}
			});

			// 收集 stderr（限制 10MB）
			child.stderr?.on("data", (data) => {
				stderr += data.toString();
				if (stderr.length > 10 * 1024 * 1024) {
					stderr = stderr.slice(0, 10 * 1024 * 1024);
				}
			});

			child.on("close", (code) => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (options?.signal) {
					options.signal.removeEventListener("abort", onAbort);
				}

				// 处理中止情况
				if (options?.signal?.aborted) {
					reject(new Error(`${stdout}\n${stderr}\nCommand aborted`.trim()));
					return;
				}

				// 处理超时情况
				if (timedOut) {
					reject(new Error(`${stdout}\n${stderr}\nCommand timed out after ${options?.timeout} seconds`.trim()));
					return;
				}

				resolve({ stdout, stderr, code: code ?? 0 });
			});
		});
	}

	/**
	 * Host 模式下直接返回原始路径
	 */
	getWorkspacePath(hostPath: string): string {
		return hostPath;
	}
}

/**
 * Docker 容器执行器
 * 通过 docker exec 在指定容器内执行命令
 */
class DockerExecutor implements Executor {
	/**
	 * @param container - Docker 容器名称
	 */
	constructor(private container: string) {}

	/**
	 * 在 Docker 容器内执行命令
	 * 将命令包装为 docker exec 调用，委托给 HostExecutor 执行
	 */
	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		const dockerCmd = `docker exec ${this.container} sh -c ${shellEscape(command)}`;
		const hostExecutor = new HostExecutor();
		return hostExecutor.exec(dockerCmd, options);
	}

	/**
	 * Docker 模式下容器看到的是 /workspace 路径
	 */
	getWorkspacePath(_hostPath: string): string {
		return "/workspace";
	}
}

/**
 * 终止进程树
 * 在 Unix 系统上使用进程组信号，在 Windows 上使用 taskkill
 * @param pid - 进程 ID
 */
function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
			});
		} catch {
			// 忽略错误
		}
	} else {
		// Unix: 先尝试按进程组终止（负 PID），失败则终止单个进程
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// 进程已经退出
			}
		}
	}
}

/**
 * Shell 参数转义
 * 使用单引号包裹并转义内部的单引号
 * @param s - 要转义的字符串
 * @returns 转义后的字符串
 */
function shellEscape(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}
