/**
 * @file TUI 框架入口文件
 *
 * 本文件是终端 UI 框架包的公共 API 入口点。
 * 从各个模块中重新导出所有公共接口、类型和类，
 * 提供统一的导入路径给外部使用者。
 *
 * 主要导出内容：
 * - 核心 TUI 类和组件接口（TUI、Container、Component）
 * - UI 组件（Editor、Input、Markdown、SelectList 等）
 * - 键盘输入处理（Key、matchesKey、parseKey）
 * - 终端图像支持（Kitty/iTerm2 协议）
 * - 自动补全系统
 * - 模糊匹配工具
 * - 文本处理工具函数
 */

// 自动补全支持
export {
	type AutocompleteItem,
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	type SlashCommand,
} from "./autocomplete.js";
// UI 组件
export { Box } from "./components/box.js";
export { CancellableLoader } from "./components/cancellable-loader.js";
export { Editor, type EditorOptions, type EditorTheme } from "./components/editor.js";
export { Image, type ImageOptions, type ImageTheme } from "./components/image.js";
export { Input } from "./components/input.js";
export { Loader } from "./components/loader.js";
export { type DefaultTextStyle, Markdown, type MarkdownTheme } from "./components/markdown.js";
export { type SelectItem, SelectList, type SelectListTheme } from "./components/select-list.js";
export { type SettingItem, SettingsList, type SettingsListTheme } from "./components/settings-list.js";
export { Spacer } from "./components/spacer.js";
export { Text } from "./components/text.js";
export { TruncatedText } from "./components/truncated-text.js";
// 编辑器组件接口（用于自定义编辑器实现）
export type { EditorComponent } from "./editor-component.js";
// 模糊匹配工具
export { type FuzzyMatch, fuzzyFilter, fuzzyMatch } from "./fuzzy.js";
// 快捷键绑定
export {
	DEFAULT_EDITOR_KEYBINDINGS,
	type EditorAction,
	type EditorKeybindingsConfig,
	EditorKeybindingsManager,
	getEditorKeybindings,
	setEditorKeybindings,
} from "./keybindings.js";
// 键盘输入处理
export {
	isKeyRelease,
	isKeyRepeat,
	isKittyProtocolActive,
	Key,
	type KeyEventType,
	type KeyId,
	matchesKey,
	parseKey,
	setKittyProtocolActive,
} from "./keys.js";
// 标准输入缓冲（用于批量分割输入序列）
export { StdinBuffer, type StdinBufferEventMap, type StdinBufferOptions } from "./stdin-buffer.js";
// 终端接口和实现
export { ProcessTerminal, type Terminal } from "./terminal.js";
// 终端图像支持
export {
	allocateImageId,
	type CellDimensions,
	calculateImageRows,
	deleteAllKittyImages,
	deleteKittyImage,
	detectCapabilities,
	encodeITerm2,
	encodeKitty,
	getCapabilities,
	getCellDimensions,
	getGifDimensions,
	getImageDimensions,
	getJpegDimensions,
	getPngDimensions,
	getWebpDimensions,
	type ImageDimensions,
	type ImageProtocol,
	type ImageRenderOptions,
	imageFallback,
	renderImage,
	resetCapabilitiesCache,
	setCellDimensions,
	type TerminalCapabilities,
} from "./terminal-image.js";
export {
	type Component,
	Container,
	CURSOR_MARKER,
	type Focusable,
	isFocusable,
	type OverlayAnchor,
	type OverlayHandle,
	type OverlayMargin,
	type OverlayOptions,
	type SizeValue,
	TUI,
} from "./tui.js";
// 文本处理工具函数
export { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "./utils.js";
