/**
 * 工具模块入口文件
 *
 * 本文件是编码智能体工具集的统一导出入口，负责：
 * 1. 重新导出所有工具模块（bash/read/write/edit/grep/find/ls）的类型和工厂函数
 * 2. 导出截断工具的常量和函数
 * 3. 提供预配置的工具集合（codingTools、readOnlyTools、allTools）
 * 4. 提供工厂函数，用于创建绑定到特定工作目录的工具实例
 */

export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	bashTool,
	createBashTool,
} from "./bash.js";
export {
	createEditTool,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
	editTool,
} from "./edit.js";
export {
	createFindTool,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
	findTool,
} from "./find.js";
export {
	createGrepTool,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
	grepTool,
} from "./grep.js";
export {
	createLsTool,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
	lsTool,
} from "./ls.js";
export {
	createReadTool,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
	readTool,
} from "./read.js";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.js";
export {
	createWriteTool,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
	writeTool,
} from "./write.js";

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type BashToolOptions, bashTool, createBashTool } from "./bash.js";
import { createEditTool, editTool } from "./edit.js";
import { createFindTool, findTool } from "./find.js";
import { createGrepTool, grepTool } from "./grep.js";
import { createLsTool, lsTool } from "./ls.js";
import { createReadTool, type ReadToolOptions, readTool } from "./read.js";
import { createWriteTool, writeTool } from "./write.js";

/** 工具类型（来自 pi-ai 的 AgentTool） */
export type Tool = AgentTool<any>;

/** 默认编码工具集（完全访问模式），使用 process.cwd() 作为工作目录 */
export const codingTools: Tool[] = [readTool, bashTool, editTool, writeTool];

/** 只读工具集（探索模式，不可修改文件），使用 process.cwd() 作为工作目录 */
export const readOnlyTools: Tool[] = [readTool, grepTool, findTool, lsTool];

/** 所有可用工具的映射表，使用 process.cwd() 作为工作目录 */
export const allTools = {
	read: readTool,
	bash: bashTool,
	edit: editTool,
	write: writeTool,
	grep: grepTool,
	find: findTool,
	ls: lsTool,
};

/** 工具名称类型，对应 allTools 的键 */
export type ToolName = keyof typeof allTools;

/** 工具集配置选项 */
export interface ToolsOptions {
	/** 读取工具的选项 */
	read?: ReadToolOptions;
	/** Bash 工具的选项 */
	bash?: BashToolOptions;
}

/**
 * 创建绑定到指定工作目录的编码工具集（read、bash、edit、write）。
 */
export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createBashTool(cwd, options?.bash),
		createEditTool(cwd),
		createWriteTool(cwd),
	];
}

/**
 * 创建绑定到指定工作目录的只读工具集（read、grep、find、ls）。
 */
export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [createReadTool(cwd, options?.read), createGrepTool(cwd), createFindTool(cwd), createLsTool(cwd)];
}

/**
 * 创建绑定到指定工作目录的所有工具，返回以工具名为键的映射表。
 */
export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		read: createReadTool(cwd, options?.read),
		bash: createBashTool(cwd, options?.bash),
		edit: createEditTool(cwd),
		write: createWriteTool(cwd),
		grep: createGrepTool(cwd),
		find: createFindTool(cwd),
		ls: createLsTool(cwd),
	};
}
