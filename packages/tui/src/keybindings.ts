/**
 * @file 编辑器快捷键绑定管理
 *
 * 本文件定义了编辑器支持的所有动作类型（EditorAction），
 * 以及对应的默认快捷键绑定。用户可以通过 EditorKeybindingsConfig
 * 自定义快捷键映射。
 *
 * EditorKeybindingsManager 负责管理快捷键配置，支持：
 * - 基于默认配置的初始化
 * - 用户自定义配置的覆盖
 * - 输入数据与动作的匹配检查
 */

import { type KeyId, matchesKey } from "./keys.js";

/**
 * 可绑定到快捷键的编辑器动作类型
 */
export type EditorAction =
	// 光标移动
	| "cursorUp"
	| "cursorDown"
	| "cursorLeft"
	| "cursorRight"
	| "cursorWordLeft"
	| "cursorWordRight"
	| "cursorLineStart"
	| "cursorLineEnd"
	| "jumpForward"
	| "jumpBackward"
	| "pageUp"
	| "pageDown"
	// 删除操作
	| "deleteCharBackward"
	| "deleteCharForward"
	| "deleteWordBackward"
	| "deleteWordForward"
	| "deleteToLineStart"
	| "deleteToLineEnd"
	// 文本输入
	| "newLine"
	| "submit"
	| "tab"
	// 选择/自动补全
	| "selectUp"
	| "selectDown"
	| "selectPageUp"
	| "selectPageDown"
	| "selectConfirm"
	| "selectCancel"
	// 剪贴板
	| "copy"
	// Kill 环（Emacs 风格的剪切/粘贴）
	| "yank"
	| "yankPop"
	// 撤销
	| "undo"
	// 工具输出展开
	| "expandTools"
	// 会话管理
	| "toggleSessionPath"
	| "toggleSessionSort"
	| "renameSession"
	| "deleteSession"
	| "deleteSessionNoninvasive";

// Re-export KeyId from keys.ts
export type { KeyId };

/**
 * 编辑器快捷键配置类型。
 * 每个动作可以绑定单个按键或多个按键。
 */
export type EditorKeybindingsConfig = {
	[K in EditorAction]?: KeyId | KeyId[];
};

/**
 * 默认编辑器快捷键绑定配置
 */
export const DEFAULT_EDITOR_KEYBINDINGS: Required<EditorKeybindingsConfig> = {
	// Cursor movement
	cursorUp: "up",
	cursorDown: "down",
	cursorLeft: ["left", "ctrl+b"],
	cursorRight: ["right", "ctrl+f"],
	cursorWordLeft: ["alt+left", "ctrl+left", "alt+b"],
	cursorWordRight: ["alt+right", "ctrl+right", "alt+f"],
	cursorLineStart: ["home", "ctrl+a"],
	cursorLineEnd: ["end", "ctrl+e"],
	jumpForward: "ctrl+]",
	jumpBackward: "ctrl+alt+]",
	pageUp: "pageUp",
	pageDown: "pageDown",
	// Deletion
	deleteCharBackward: "backspace",
	deleteCharForward: ["delete", "ctrl+d"],
	deleteWordBackward: ["ctrl+w", "alt+backspace"],
	deleteWordForward: ["alt+d", "alt+delete"],
	deleteToLineStart: "ctrl+u",
	deleteToLineEnd: "ctrl+k",
	// Text input
	newLine: "shift+enter",
	submit: "enter",
	tab: "tab",
	// Selection/autocomplete
	selectUp: "up",
	selectDown: "down",
	selectPageUp: "pageUp",
	selectPageDown: "pageDown",
	selectConfirm: "enter",
	selectCancel: ["escape", "ctrl+c"],
	// Clipboard
	copy: "ctrl+c",
	// Kill ring
	yank: "ctrl+y",
	yankPop: "alt+y",
	// Undo
	undo: "ctrl+-",
	// Tool output
	expandTools: "ctrl+o",
	// Session
	toggleSessionPath: "ctrl+p",
	toggleSessionSort: "ctrl+s",
	renameSession: "ctrl+r",
	deleteSession: "ctrl+d",
	deleteSessionNoninvasive: "ctrl+backspace",
};

/**
 * 编辑器快捷键管理器。
 * 管理动作到按键的映射，支持默认配置和用户自定义覆盖。
 */
export class EditorKeybindingsManager {
	/** 动作到按键数组的映射 */
	private actionToKeys: Map<EditorAction, KeyId[]>;

	constructor(config: EditorKeybindingsConfig = {}) {
		this.actionToKeys = new Map();
		this.buildMaps(config);
	}

	private buildMaps(config: EditorKeybindingsConfig): void {
		this.actionToKeys.clear();

		// Start with defaults
		for (const [action, keys] of Object.entries(DEFAULT_EDITOR_KEYBINDINGS)) {
			const keyArray = Array.isArray(keys) ? keys : [keys];
			this.actionToKeys.set(action as EditorAction, [...keyArray]);
		}

		// Override with user config
		for (const [action, keys] of Object.entries(config)) {
			if (keys === undefined) continue;
			const keyArray = Array.isArray(keys) ? keys : [keys];
			this.actionToKeys.set(action as EditorAction, keyArray);
		}
	}

	/**
	 * 检查输入是否匹配指定的动作。
	 */
	matches(data: string, action: EditorAction): boolean {
		const keys = this.actionToKeys.get(action);
		if (!keys) return false;
		for (const key of keys) {
			if (matchesKey(data, key)) return true;
		}
		return false;
	}

	/**
	 * 获取绑定到指定动作的所有按键。
	 */
	getKeys(action: EditorAction): KeyId[] {
		return this.actionToKeys.get(action) ?? [];
	}

	/**
	 * 更新快捷键配置。
	 */
	setConfig(config: EditorKeybindingsConfig): void {
		this.buildMaps(config);
	}
}

// 全局单例
let globalEditorKeybindings: EditorKeybindingsManager | null = null;

/** 获取全局编辑器快捷键管理器实例（懒初始化） */
export function getEditorKeybindings(): EditorKeybindingsManager {
	if (!globalEditorKeybindings) {
		globalEditorKeybindings = new EditorKeybindingsManager();
	}
	return globalEditorKeybindings;
}

/** 设置全局编辑器快捷键管理器实例 */
export function setEditorKeybindings(manager: EditorKeybindingsManager): void {
	globalEditorKeybindings = manager;
}
