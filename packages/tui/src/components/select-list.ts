/**
 * @file 可选择列表组件
 *
 * 提供带有上下键导航、滚动和过滤功能的选择列表。
 * 支持项目描述显示和滚动指示器。
 */

import { getEditorKeybindings } from "../keybindings.js";
import type { Component } from "../tui.js";
import { truncateToWidth } from "../utils.js";

/** 将多行文本规范化为单行 */
const normalizeToSingleLine = (text: string): string => text.replace(/[\r\n]+/g, " ").trim();

/** 选择列表项 */
export interface SelectItem {
	/** 项目值（用于程序处理） */
	value: string;
	/** 显示标签 */
	label: string;
	/** 可选描述文本 */
	description?: string;
}

/** 选择列表主题配置 */
export interface SelectListTheme {
	/** 选中项前缀样式（如 "→"） */
	selectedPrefix: (text: string) => string;
	/** 选中项文本样式 */
	selectedText: (text: string) => string;
	/** 描述文本样式 */
	description: (text: string) => string;
	/** 滚动信息样式 */
	scrollInfo: (text: string) => string;
	/** 无匹配结果提示样式 */
	noMatch: (text: string) => string;
}

/**
 * 可选择列表组件。
 * 支持键盘导航（上/下/回车/Escape）、过滤和滚动。
 * 选中项通过 onSelect 回调通知。
 */
export class SelectList implements Component {
	/** 所有项目列表 */
	private items: SelectItem[] = [];
	/** 过滤后的项目列表 */
	private filteredItems: SelectItem[] = [];
	/** 当前选中项索引 */
	private selectedIndex: number = 0;
	/** 最大可见行数 */
	private maxVisible: number = 5;
	/** 主题配置 */
	private theme: SelectListTheme;

	/** 项目被选中时的回调 */
	public onSelect?: (item: SelectItem) => void;
	/** 取消选择时的回调 */
	public onCancel?: () => void;
	/** 选择项变化时的回调（导航时触发） */
	public onSelectionChange?: (item: SelectItem) => void;

	constructor(items: SelectItem[], maxVisible: number, theme: SelectListTheme) {
		this.items = items;
		this.filteredItems = items;
		this.maxVisible = maxVisible;
		this.theme = theme;
	}

	/** 设置过滤器文本，重新过滤项目列表 */
	setFilter(filter: string): void {
		this.filteredItems = this.items.filter((item) => item.value.toLowerCase().startsWith(filter.toLowerCase()));
		// Reset selection when filter changes
		this.selectedIndex = 0;
	}

	/** 设置选中项索引（自动限制在有效范围内） */
	setSelectedIndex(index: number): void {
		this.selectedIndex = Math.max(0, Math.min(index, this.filteredItems.length - 1));
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		const lines: string[] = [];

		// If no items match filter, show message
		if (this.filteredItems.length === 0) {
			lines.push(this.theme.noMatch("  No matching commands"));
			return lines;
		}

		// Calculate visible range with scrolling
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredItems.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);

		// Render visible items
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredItems[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;
			const descriptionSingleLine = item.description ? normalizeToSingleLine(item.description) : undefined;

			let line = "";
			if (isSelected) {
				// Use arrow indicator for selection - entire line uses selectedText color
				const prefixWidth = 2; // "→ " is 2 characters visually
				const displayValue = item.label || item.value;

				if (descriptionSingleLine && width > 40) {
					// Calculate how much space we have for value + description
					const maxValueWidth = Math.min(30, width - prefixWidth - 4);
					const truncatedValue = truncateToWidth(displayValue, maxValueWidth, "");
					const spacing = " ".repeat(Math.max(1, 32 - truncatedValue.length));

					// Calculate remaining space for description using visible widths
					const descriptionStart = prefixWidth + truncatedValue.length + spacing.length;
					const remainingWidth = width - descriptionStart - 2; // -2 for safety

					if (remainingWidth > 10) {
						const truncatedDesc = truncateToWidth(descriptionSingleLine, remainingWidth, "");
						// Apply selectedText to entire line content
						line = this.theme.selectedText(`→ ${truncatedValue}${spacing}${truncatedDesc}`);
					} else {
						// Not enough space for description
						const maxWidth = width - prefixWidth - 2;
						line = this.theme.selectedText(`→ ${truncateToWidth(displayValue, maxWidth, "")}`);
					}
				} else {
					// No description or not enough width
					const maxWidth = width - prefixWidth - 2;
					line = this.theme.selectedText(`→ ${truncateToWidth(displayValue, maxWidth, "")}`);
				}
			} else {
				const displayValue = item.label || item.value;
				const prefix = "  ";

				if (descriptionSingleLine && width > 40) {
					// Calculate how much space we have for value + description
					const maxValueWidth = Math.min(30, width - prefix.length - 4);
					const truncatedValue = truncateToWidth(displayValue, maxValueWidth, "");
					const spacing = " ".repeat(Math.max(1, 32 - truncatedValue.length));

					// Calculate remaining space for description
					const descriptionStart = prefix.length + truncatedValue.length + spacing.length;
					const remainingWidth = width - descriptionStart - 2; // -2 for safety

					if (remainingWidth > 10) {
						const truncatedDesc = truncateToWidth(descriptionSingleLine, remainingWidth, "");
						const descText = this.theme.description(spacing + truncatedDesc);
						line = prefix + truncatedValue + descText;
					} else {
						// Not enough space for description
						const maxWidth = width - prefix.length - 2;
						line = prefix + truncateToWidth(displayValue, maxWidth, "");
					}
				} else {
					// No description or not enough width
					const maxWidth = width - prefix.length - 2;
					line = prefix + truncateToWidth(displayValue, maxWidth, "");
				}
			}

			lines.push(line);
		}

		// Add scroll indicators if needed
		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			const scrollText = `  (${this.selectedIndex + 1}/${this.filteredItems.length})`;
			// Truncate if too long for terminal
			lines.push(this.theme.scrollInfo(truncateToWidth(scrollText, width - 2, "")));
		}

		return lines;
	}

	/** 处理键盘输入（上/下导航、回车确认、Escape 取消） */
	handleInput(keyData: string): void {
		const kb = getEditorKeybindings();
		// Up arrow - wrap to bottom when at top
		if (kb.matches(keyData, "selectUp")) {
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
			this.notifySelectionChange();
		}
		// Down arrow - wrap to top when at bottom
		else if (kb.matches(keyData, "selectDown")) {
			this.selectedIndex = this.selectedIndex === this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
			this.notifySelectionChange();
		}
		// Enter
		else if (kb.matches(keyData, "selectConfirm")) {
			const selectedItem = this.filteredItems[this.selectedIndex];
			if (selectedItem && this.onSelect) {
				this.onSelect(selectedItem);
			}
		}
		// Escape or Ctrl+C
		else if (kb.matches(keyData, "selectCancel")) {
			if (this.onCancel) {
				this.onCancel();
			}
		}
	}

	private notifySelectionChange(): void {
		const selectedItem = this.filteredItems[this.selectedIndex];
		if (selectedItem && this.onSelectionChange) {
			this.onSelectionChange(selectedItem);
		}
	}

	/** 获取当前选中的项目 */
	getSelectedItem(): SelectItem | null {
		const item = this.filteredItems[this.selectedIndex];
		return item || null;
	}
}
