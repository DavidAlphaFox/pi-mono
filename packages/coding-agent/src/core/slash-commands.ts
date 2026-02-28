/**
 * 斜杠命令定义模块
 *
 * 职责：
 * - 定义斜杠命令的类型和来源分类
 * - 提供内置斜杠命令列表（settings、model、export 等）
 */

/** 斜杠命令来源 */
export type SlashCommandSource = "extension" | "prompt" | "skill";

/** 斜杠命令位置 - 来自用户全局、项目或路径 */
export type SlashCommandLocation = "user" | "project" | "path";

/** 斜杠命令信息 */
export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	location?: SlashCommandLocation;
	path?: string;
}

/** 内置斜杠命令定义 */
export interface BuiltinSlashCommand {
	name: string;
	description: string;
}

/** 所有内置斜杠命令列表 */
export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "export", description: "Export session to HTML file" },
	{ name: "share", description: "Share session as a secret GitHub gist" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous message" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "login", description: "Login with OAuth provider" },
	{ name: "logout", description: "Logout from OAuth provider" },
	{ name: "new", description: "Start a new session" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "reload", description: "Reload extensions, skills, prompts, and themes" },
	{ name: "quit", description: "Quit pi" },
];
