/**
 * @file 核心类型定义文件
 *
 * 本文件定义了 GPU Pod 管理工具的所有核心数据类型，包括：
 * - GPU 硬件信息
 * - 模型部署信息
 * - Pod 配置信息
 * - 全局配置结构
 */

/**
 * GPU 设备信息
 * 描述 Pod 上单个 GPU 的硬件属性
 */
export interface GPU {
	/** GPU 设备编号（对应 CUDA 设备索引） */
	id: number;
	/** GPU 名称（如 "NVIDIA H200"） */
	name: string;
	/** GPU 显存大小（如 "80 GiB"） */
	memory: string;
}

/**
 * 模型部署信息
 * 描述一个正在运行的 vLLM 模型实例
 */
export interface Model {
	/** 模型标识符（如 HuggingFace 模型 ID） */
	model: string;
	/** vLLM 服务监听端口 */
	port: number;
	/** 分配的 GPU 设备 ID 列表（支持多 GPU 张量并行部署） */
	gpu: number[];
	/** 模型运行进程的 PID */
	pid: number;
}

/**
 * Pod 配置信息
 * 描述一个 GPU Pod 的完整配置，包括连接信息、硬件信息和已部署的模型
 */
export interface Pod {
	/** SSH 连接命令（如 "ssh root@1.2.3.4"） */
	ssh: string;
	/** Pod 上可用的 GPU 列表 */
	gpus: GPU[];
	/** 已部署的模型，以模型别名为键 */
	models: Record<string, Model>;
	/** 模型文件存储路径（远程挂载目录） */
	modelsPath?: string;
	/** 已安装的 vLLM 版本类型 */
	vllmVersion?: "release" | "nightly" | "gpt-oss";
}

/**
 * 全局配置结构
 * 存储所有已配置的 Pod 及当前活跃 Pod 信息
 */
export interface Config {
	/** 所有已配置的 Pod，以名称为键 */
	pods: Record<string, Pod>;
	/** 当前活跃 Pod 的名称 */
	active?: string;
}
