/**
 * 核心模块的统一导出入口 - 所有运行模式共享的基础模块
 *
 * 职责：
 * - 导出 AgentSession 及其相关类型（会话管理核心）
 * - 导出 Bash 执行器（命令执行基础设施）
 * - 导出压缩系统（上下文窗口管理）
 * - 导出事件总线（模块间通信）
 * - 导出扩展系统的完整类型和实现
 */

export {
	AgentSession,
	type AgentSessionConfig,
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type ModelCycleResult,
	type PromptOptions,
	type SessionStats,
} from "./agent-session.js";
export { type BashExecutorOptions, type BashResult, executeBash, executeBashWithOperations } from "./bash-executor.js";
export type { CompactionResult } from "./compaction/index.js";
export { createEventBus, type EventBus, type EventBusController } from "./event-bus.js";

// Extensions system
export {
	type AgentEndEvent,
	type AgentStartEvent,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type BeforeAgentStartEvent,
	type ContextEvent,
	discoverAndLoadExtensions,
	type ExecOptions,
	type ExecResult,
	type Extension,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionError,
	type ExtensionEvent,
	type ExtensionFactory,
	type ExtensionFlag,
	type ExtensionHandler,
	ExtensionRunner,
	type ExtensionShortcut,
	type ExtensionUIContext,
	type LoadExtensionsResult,
	type MessageRenderer,
	type RegisteredCommand,
	type SessionBeforeCompactEvent,
	type SessionBeforeForkEvent,
	type SessionBeforeSwitchEvent,
	type SessionBeforeTreeEvent,
	type SessionCompactEvent,
	type SessionForkEvent,
	type SessionShutdownEvent,
	type SessionStartEvent,
	type SessionSwitchEvent,
	type SessionTreeEvent,
	type ToolCallEvent,
	type ToolDefinition,
	type ToolRenderResultOptions,
	type ToolResultEvent,
	type TurnEndEvent,
	type TurnStartEvent,
	wrapToolsWithExtensions,
} from "./extensions/index.js";
