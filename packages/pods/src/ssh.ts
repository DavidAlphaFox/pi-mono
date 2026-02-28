/**
 * @file SSH 远程执行模块
 *
 * 本文件封装了通过 SSH 与远程 GPU Pod 交互的核心功能，包括：
 * - 执行远程命令并捕获输出（sshExec）
 * - 执行远程命令并流式传输输出到控制台（sshExecStream）
 * - 通过 SCP 上传文件到远程 Pod（scpFile）
 *
 * 所有函数都支持 SSH 心跳保活，防止长时间运行的命令因连接超时而中断。
 */
import { type SpawnOptions, spawn } from "child_process";

/**
 * SSH 命令执行结果
 */
export interface SSHResult {
	/** 标准输出内容 */
	stdout: string;
	/** 标准错误输出内容 */
	stderr: string;
	/** 进程退出码 */
	exitCode: number;
}

/**
 * 执行 SSH 命令并返回完整结果
 * 将命令发送到远程主机执行，等待完成后返回所有输出
 * @param sshCmd - SSH 连接命令（如 "ssh root@1.2.3.4" 或 "ssh -p 22 root@1.2.3.4"）
 * @param command - 要在远程主机上执行的命令
 * @param options - 可选配置
 * @param options.keepAlive - 是否启用 SSH 心跳保活（每30秒发送一次，最多允许120次失败）
 * @returns 包含 stdout、stderr 和退出码的执行结果
 */
export const sshExec = async (
	sshCmd: string,
	command: string,
	options?: { keepAlive?: boolean },
): Promise<SSHResult> => {
	return new Promise((resolve) => {
		// 解析 SSH 命令（如 "ssh root@1.2.3.4" 或 "ssh -p 22 root@1.2.3.4"）
		const sshParts = sshCmd.split(" ").filter((p) => p);
		const sshBinary = sshParts[0];
		let sshArgs = [...sshParts.slice(1)];

		// 为长时间运行的命令添加 SSH 心跳保活选项
		if (options?.keepAlive) {
			// ServerAliveInterval=30 每30秒发送一次心跳
			// ServerAliveCountMax=120 最多允许120次失败（总计约60分钟）
			sshArgs = ["-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=120", ...sshArgs];
		}

		sshArgs.push(command);

		const proc = spawn(sshBinary, sshArgs, {
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		// 收集标准输出
		proc.stdout.on("data", (data) => {
			stdout += data.toString();
		});

		// 收集标准错误输出
		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		// 进程正常退出时返回结果
		proc.on("close", (code) => {
			resolve({
				stdout,
				stderr,
				exitCode: code || 0,
			});
		});

		// 进程启动出错时返回错误信息
		proc.on("error", (err) => {
			resolve({
				stdout,
				stderr: err.message,
				exitCode: 1,
			});
		});
	});
};

/**
 * 执行 SSH 命令并将输出流式传输到控制台
 * 适用于需要实时查看输出的场景，如日志流、安装过程等
 * @param sshCmd - SSH 连接命令
 * @param command - 要在远程主机上执行的命令
 * @param options - 可选配置
 * @param options.silent - 是否静默模式（不输出任何内容）
 * @param options.forceTTY - 是否强制分配伪终端（-t 参数，用于保留颜色输出）
 * @param options.keepAlive - 是否启用 SSH 心跳保活
 * @returns 进程退出码
 */
export const sshExecStream = async (
	sshCmd: string,
	command: string,
	options?: { silent?: boolean; forceTTY?: boolean; keepAlive?: boolean },
): Promise<number> => {
	return new Promise((resolve) => {
		const sshParts = sshCmd.split(" ").filter((p) => p);
		const sshBinary = sshParts[0];

		// 构建 SSH 参数列表
		let sshArgs = [...sshParts.slice(1)];

		// 如果需要伪终端且尚未指定 -t 参数，则添加
		if (options?.forceTTY && !sshParts.includes("-t")) {
			sshArgs = ["-t", ...sshArgs];
		}

		// 为长时间运行的命令添加心跳保活
		if (options?.keepAlive) {
			sshArgs = ["-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=120", ...sshArgs];
		}

		sshArgs.push(command);

		// 根据静默模式决定输出方式：静默时忽略所有输出，否则继承父进程的标准输入输出
		const spawnOptions: SpawnOptions = options?.silent
			? { stdio: ["ignore", "ignore", "ignore"] }
			: { stdio: "inherit" };

		const proc = spawn(sshBinary, sshArgs, spawnOptions);

		proc.on("close", (code) => {
			resolve(code || 0);
		});

		proc.on("error", () => {
			resolve(1);
		});
	});
};

/**
 * 通过 SCP 上传文件到远程主机
 * 从 SSH 命令中解析主机地址和端口，构建 SCP 命令进行文件传输
 * @param sshCmd - SSH 连接命令（用于提取主机信息）
 * @param localPath - 本地文件路径
 * @param remotePath - 远程目标路径
 * @returns 上传是否成功
 */
export const scpFile = async (sshCmd: string, localPath: string, remotePath: string): Promise<boolean> => {
	// 从 SSH 命令中解析主机和端口信息
	const sshParts = sshCmd.split(" ").filter((p) => p);
	let host = "";
	let port = "22";
	let i = 1; // 跳过 'ssh' 命令本身

	while (i < sshParts.length) {
		if (sshParts[i] === "-p" && i + 1 < sshParts.length) {
			// 解析 -p 端口参数
			port = sshParts[i + 1];
			i += 2;
		} else if (!sshParts[i].startsWith("-")) {
			// 非选项参数即为主机地址
			host = sshParts[i];
			break;
		} else {
			i++;
		}
	}

	if (!host) {
		console.error("Could not parse host from SSH command");
		return false;
	}

	// 构建 SCP 命令：-P 指定端口，目标格式为 host:remotePath
	const scpArgs = ["-P", port, localPath, `${host}:${remotePath}`];

	return new Promise((resolve) => {
		const proc = spawn("scp", scpArgs, { stdio: "inherit" });

		proc.on("close", (code) => {
			resolve(code === 0);
		});

		proc.on("error", () => {
			resolve(false);
		});
	});
};
