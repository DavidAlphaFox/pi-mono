/**
 * RPC 协议类型定义，用于无界面（headless）操作模式。
 *
 * 该文件定义了 RPC 模式下所有的通信类型：
 * - 命令（RpcCommand）：通过 stdin 以 JSON 行发送
 * - 响应（RpcResponse）：通过 stdout 以 JSON 行返回
 * - 事件（RpcExtensionUIRequest/Response）：扩展 UI 交互事件
 * - 会话状态（RpcSessionState）：当前会话的状态快照
 *
 * 这些类型确保了 RPC 客户端和服务端之间的类型安全通信。
 */

import type { AgentMessage, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ImageContent, Model } from "@mariozechner/pi-ai";
import type { SessionStats } from "../../core/agent-session.js";
import type { BashResult } from "../../core/bash-executor.js";
import type { CompactionResult } from "../../core/compaction/index.js";

// ============================================================================
// RPC 命令类型（通过 stdin 发送）
// ============================================================================

/**
 * RPC 命令联合类型。
 * 定义了所有可通过 stdin 发送给代理的命令，
 * 涵盖提示、状态查询、模型管理、会话操作等功能。
 * 每个命令可携带可选的 `id` 字段用于匹配响应。
 */
export type RpcCommand =
	// Prompting
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "new_session"; parentSession?: string }

	// State
	| { id?: string; type: "get_state" }

	// Model
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }

	// Thinking
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }

	// Queue modes
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }

	// Compaction
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }

	// Retry
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }

	// Bash
	| { id?: string; type: "bash"; command: string }
	| { id?: string; type: "abort_bash" }

	// Session
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "fork"; entryId: string }
	| { id?: string; type: "get_fork_messages" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }

	// Messages
	| { id?: string; type: "get_messages" }

	// Commands (available for invocation via prompt)
	| { id?: string; type: "get_commands" };

// ============================================================================
// RPC 斜杠命令（用于 get_commands 响应）
// ============================================================================

/** 可通过提示词调用的命令描述 */
export interface RpcSlashCommand {
	/** 命令名称（不含前导斜杠） */
	name: string;
	/** 人类可读的命令描述 */
	description?: string;
	/** 命令的来源类型 */
	source: "extension" | "prompt" | "skill";
	/** 命令加载的位置（扩展命令时为 undefined） */
	location?: "user" | "project" | "path";
	/** 命令源文件的路径 */
	path?: string;
}

// ============================================================================
// RPC 会话状态
// ============================================================================

/**
 * RPC 会话状态快照。
 * 通过 get_state 命令返回，反映代理的当前运行状态。
 */
export interface RpcSessionState {
	/** 当前使用的模型 */
	model?: Model<any>;
	/** 当前思考级别 */
	thinkingLevel: ThinkingLevel;
	/** 是否正在流式输出 */
	isStreaming: boolean;
	/** 是否正在执行上下文压缩 */
	isCompacting: boolean;
	/** 引导消息处理模式 */
	steeringMode: "all" | "one-at-a-time";
	/** 后续消息处理模式 */
	followUpMode: "all" | "one-at-a-time";
	/** 当前会话文件路径 */
	sessionFile?: string;
	/** 会话唯一标识符 */
	sessionId: string;
	/** 会话显示名称 */
	sessionName?: string;
	/** 是否启用自动压缩 */
	autoCompactionEnabled: boolean;
	/** 会话中的消息总数 */
	messageCount: number;
	/** 待处理的消息数量 */
	pendingMessageCount: number;
}

// ============================================================================
// RPC 响应类型（通过 stdout 输出）
// ============================================================================

/**
 * RPC 响应联合类型。
 * 每个命令对应一种成功响应格式，失败时统一返回错误响应。
 * 响应通过 `id` 字段与请求命令匹配。
 */
export type RpcResponse =
	// Prompting (async - events follow)
	| { id?: string; type: "response"; command: "prompt"; success: true }
	| { id?: string; type: "response"; command: "steer"; success: true }
	| { id?: string; type: "response"; command: "follow_up"; success: true }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }

	// State
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }

	// Model
	| {
			id?: string;
			type: "response";
			command: "set_model";
			success: true;
			data: Model<any>;
	  }
	| {
			id?: string;
			type: "response";
			command: "cycle_model";
			success: true;
			data: { model: Model<any>; thinkingLevel: ThinkingLevel; isScoped: boolean } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			data: { models: Model<any>[] };
	  }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| {
			id?: string;
			type: "response";
			command: "cycle_thinking_level";
			success: true;
			data: { level: ThinkingLevel } | null;
	  }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }

	// Retry
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }

	// Bash
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "fork"; success: true; data: { text: string; cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "get_fork_messages";
			success: true;
			data: { messages: Array<{ entryId: string; text: string }> };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_last_assistant_text";
			success: true;
			data: { text: string | null };
	  }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }

	// Commands
	| {
			id?: string;
			type: "response";
			command: "get_commands";
			success: true;
			data: { commands: RpcSlashCommand[] };
	  }

	// Error response (any command can fail)
	| { id?: string; type: "response"; command: string; success: false; error: string };

// ============================================================================
// 扩展 UI 事件（通过 stdout 输出）
// ============================================================================

/**
 * 扩展 UI 请求事件。
 * 当扩展需要用户输入时发出，支持选择、确认、文本输入、编辑器、
 * 通知、状态设置、部件设置、标题设置等交互方式。
 */
export type RpcExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

// ============================================================================
// 扩展 UI 命令（通过 stdin 发送）
// ============================================================================

/**
 * 扩展 UI 请求的响应。
 * 客户端收到 RpcExtensionUIRequest 后，通过此类型发送响应。
 * 支持返回选择值、确认结果或取消操作。
 */
export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };

// ============================================================================
// 辅助类型：提取命令类型字符串
// ============================================================================

/** 所有 RPC 命令的 type 字段联合类型 */
export type RpcCommandType = RpcCommand["type"];
