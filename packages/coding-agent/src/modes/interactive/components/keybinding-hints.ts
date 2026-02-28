/**
 * 快捷键提示格式化工具。
 *
 * 该文件提供在 TUI 界面中格式化快捷键提示的工具函数，
 * 支持编辑器级别和应用级别的快捷键显示，
 * 使用主题颜色渲染快捷键名称（暗色）和描述文本（柔和色）。
 */

import { type EditorAction, getEditorKeybindings, type KeyId } from "@mariozechner/pi-tui";
import type { AppAction, KeybindingsManager } from "../../../core/keybindings.js";
import { theme } from "../theme/theme.js";

/**
 * 将键数组格式化为显示字符串（例如 ["ctrl+c", "escape"] -> "ctrl+c/escape"）。
 */
function formatKeys(keys: KeyId[]): string {
	if (keys.length === 0) return "";
	if (keys.length === 1) return keys[0]!;
	return keys.join("/");
}

/**
 * 获取编辑器操作的快捷键显示字符串。
 */
export function editorKey(action: EditorAction): string {
	return formatKeys(getEditorKeybindings().getKeys(action));
}

/**
 * 获取应用级操作的快捷键显示字符串。
 */
export function appKey(keybindings: KeybindingsManager, action: AppAction): string {
	return formatKeys(keybindings.getKeys(action));
}

/**
 * 格式化编辑器级快捷键提示，使用一致的样式：暗色键名，柔和色描述。
 * 自动从编辑器快捷键配置中查找对应的键。
 *
 * @param action - 编辑器操作名（如 "selectConfirm"、"expandTools"）
 * @param description - 描述文本（如 "to expand"、"cancel"）
 * @returns 格式化后的字符串
 */
export function keyHint(action: EditorAction, description: string): string {
	return theme.fg("dim", editorKey(action)) + theme.fg("muted", ` ${description}`);
}

/**
 * 格式化应用级快捷键提示。
 * 需要 KeybindingsManager 实例来查找键绑定。
 *
 * @param keybindings - 快捷键管理器实例
 * @param action - 应用操作名（如 "interrupt"、"externalEditor"）
 * @param description - 描述文本
 * @returns 格式化后的字符串
 */
export function appKeyHint(keybindings: KeybindingsManager, action: AppAction, description: string): string {
	return theme.fg("dim", appKey(keybindings, action)) + theme.fg("muted", ` ${description}`);
}

/**
 * 格式化原始键名字符串和描述（用于不可配置的键，如 ↑↓）。
 *
 * @param key - 原始键名字符串
 * @param description - 描述文本
 * @returns 格式化后的字符串
 */
export function rawKeyHint(key: string, description: string): string {
	return theme.fg("dim", key) + theme.fg("muted", ` ${description}`);
}
