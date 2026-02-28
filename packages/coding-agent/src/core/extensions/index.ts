/**
 * 扩展系统模块入口文件
 *
 * 本模块实现了编码智能体的扩展系统，允许通过 TypeScript 模块扩展功能：
 * - types.ts: 扩展系统的所有类型定义（事件、上下文、工具等）
 * - loader.ts: 扩展加载器（发现、加载和初始化扩展模块）
 * - runner.ts: 扩展运行器（管理扩展生命周期、分发事件）
 * - wrapper.ts: 工具包装器（将扩展注册的工具与事件回调集成）
 */

export type { SlashCommandInfo, SlashCommandLocation, SlashCommandSource } from "../slash-commands.js";
export {
	createExtensionRuntime,
	discoverAndLoadExtensions,
	loadExtensionFromFactory,
	loadExtensions,
} from "./loader.js";
export type {
	ExtensionErrorListener,
	ForkHandler,
	NavigateTreeHandler,
	NewSessionHandler,
	ShutdownHandler,
	SwitchSessionHandler,
} from "./runner.js";
export { ExtensionRunner } from "./runner.js";
export type {
	AgentEndEvent,
	AgentStartEvent,
	// Re-exports
	AgentToolResult,
	AgentToolUpdateCallback,
	// App keybindings (for custom editors)
	AppAction,
	AppendEntryHandler,
	// Events - Tool (ToolCallEvent types)
	BashToolCallEvent,
	BashToolResultEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	// Context
	CompactOptions,
	// Events - Agent
	ContextEvent,
	// Event Results
	ContextEventResult,
	ContextUsage,
	CustomToolCallEvent,
	CustomToolResultEvent,
	EditToolCallEvent,
	EditToolResultEvent,
	ExecOptions,
	ExecResult,
	Extension,
	ExtensionActions,
	// API
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionContextActions,
	// Errors
	ExtensionError,
	ExtensionEvent,
	ExtensionFactory,
	ExtensionFlag,
	ExtensionHandler,
	// Runtime
	ExtensionRuntime,
	ExtensionShortcut,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	FindToolCallEvent,
	FindToolResultEvent,
	GetActiveToolsHandler,
	GetAllToolsHandler,
	GetCommandsHandler,
	GetThinkingLevelHandler,
	GrepToolCallEvent,
	GrepToolResultEvent,
	// Events - Input
	InputEvent,
	InputEventResult,
	InputSource,
	KeybindingsManager,
	LoadExtensionsResult,
	LsToolCallEvent,
	LsToolResultEvent,
	// Events - Message
	MessageEndEvent,
	// Message Rendering
	MessageRenderer,
	MessageRenderOptions,
	MessageStartEvent,
	MessageUpdateEvent,
	ModelSelectEvent,
	ModelSelectSource,
	// Provider Registration
	ProviderConfig,
	ProviderModelConfig,
	ReadToolCallEvent,
	ReadToolResultEvent,
	// Commands
	RegisteredCommand,
	RegisteredTool,
	// Events - Resources
	ResourcesDiscoverEvent,
	ResourcesDiscoverResult,
	SendMessageHandler,
	SendUserMessageHandler,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
	SessionBeforeForkEvent,
	SessionBeforeForkResult,
	SessionBeforeSwitchEvent,
	SessionBeforeSwitchResult,
	SessionBeforeTreeEvent,
	SessionBeforeTreeResult,
	SessionCompactEvent,
	SessionEvent,
	SessionForkEvent,
	SessionShutdownEvent,
	// Events - Session
	SessionStartEvent,
	SessionSwitchEvent,
	SessionTreeEvent,
	SetActiveToolsHandler,
	SetLabelHandler,
	SetModelHandler,
	SetThinkingLevelHandler,
	TerminalInputHandler,
	// Events - Tool
	ToolCallEvent,
	ToolCallEventResult,
	// Tools
	ToolDefinition,
	// Events - Tool Execution
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	ToolInfo,
	ToolRenderResultOptions,
	ToolResultEvent,
	ToolResultEventResult,
	TreePreparation,
	TurnEndEvent,
	TurnStartEvent,
	// Events - User Bash
	UserBashEvent,
	UserBashEventResult,
	WidgetPlacement,
	WriteToolCallEvent,
	WriteToolResultEvent,
} from "./types.js";
// Type guards
export {
	isBashToolResult,
	isEditToolResult,
	isFindToolResult,
	isGrepToolResult,
	isLsToolResult,
	isReadToolResult,
	isToolCallEventType,
	isWriteToolResult,
} from "./types.js";
export {
	wrapRegisteredTool,
	wrapRegisteredTools,
	wrapToolsWithExtensions,
	wrapToolWithExtensions,
} from "./wrapper.js";
