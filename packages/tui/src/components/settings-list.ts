/**
 * @file 设置列表组件
 *
 * 提供设置项的列表视图，支持：
 * - 值循环切换（Enter/Space）
 * - 子菜单打开
 * - 模糊搜索过滤
 * - 项目描述显示
 * - 键盘导航
 */

import { fuzzyFilter } from "../fuzzy.js";
import { getEditorKeybindings } from "../keybindings.js";
import type { Component } from "../tui.js";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils.js";
import { Input } from "./input.js";

/** 设置项定义 */
export interface SettingItem {
	/** 设置项唯一标识符 */
	id: string;
	/** 显示标签（左侧） */
	label: string;
	/** 可选描述（选中时显示） */
	description?: string;
	/** 当前值（右侧显示） */
	currentValue: string;
	/** 如果提供，Enter/Space 在这些值之间循环切换 */
	values?: string[];
	/** 如果提供，Enter 打开此子菜单。接收当前值和完成回调。 */
	submenu?: (currentValue: string, done: (selectedValue?: string) => void) => Component;
}

/** 设置列表主题配置 */
export interface SettingsListTheme {
	/** 标签样式函数 */
	label: (text: string, selected: boolean) => string;
	/** 值样式函数 */
	value: (text: string, selected: boolean) => string;
	/** 描述文本样式函数 */
	description: (text: string) => string;
	/** 选中项光标字符串 */
	cursor: string;
	/** 提示文本样式函数 */
	hint: (text: string) => string;
}

/** 设置列表选项 */
export interface SettingsListOptions {
	/** 是否启用搜索过滤功能 */
	enableSearch?: boolean;
}

/**
 * 设置列表组件。
 * 显示设置项列表，支持值切换、子菜单和搜索过滤。
 */
export class SettingsList implements Component {
	/** 所有设置项 */
	private items: SettingItem[];
	/** 过滤后的设置项 */
	private filteredItems: SettingItem[];
	/** 主题配置 */
	private theme: SettingsListTheme;
	/** 当前选中项索引 */
	private selectedIndex = 0;
	/** 最大可见行数 */
	private maxVisible: number;
	/** 设置值变化时的回调 */
	private onChange: (id: string, newValue: string) => void;
	/** 取消时的回调 */
	private onCancel: () => void;
	/** 搜索输入框（启用搜索时存在） */
	private searchInput?: Input;
	/** 是否启用搜索功能 */
	private searchEnabled: boolean;

	// 子菜单状态
	/** 当前打开的子菜单组件 */
	private submenuComponent: Component | null = null;
	/** 打开子菜单的项目索引（用于返回时恢复选择） */
	private submenuItemIndex: number | null = null;

	constructor(
		items: SettingItem[],
		maxVisible: number,
		theme: SettingsListTheme,
		onChange: (id: string, newValue: string) => void,
		onCancel: () => void,
		options: SettingsListOptions = {},
	) {
		this.items = items;
		this.filteredItems = items;
		this.maxVisible = maxVisible;
		this.theme = theme;
		this.onChange = onChange;
		this.onCancel = onCancel;
		this.searchEnabled = options.enableSearch ?? false;
		if (this.searchEnabled) {
			this.searchInput = new Input();
		}
	}

	/** 更新指定设置项的当前值 */
	updateValue(id: string, newValue: string): void {
		const item = this.items.find((i) => i.id === id);
		if (item) {
			item.currentValue = newValue;
		}
	}

	invalidate(): void {
		this.submenuComponent?.invalidate?.();
	}

	render(width: number): string[] {
		// If submenu is active, render it instead
		if (this.submenuComponent) {
			return this.submenuComponent.render(width);
		}

		return this.renderMainList(width);
	}

	private renderMainList(width: number): string[] {
		const lines: string[] = [];

		if (this.searchEnabled && this.searchInput) {
			lines.push(...this.searchInput.render(width));
			lines.push("");
		}

		if (this.items.length === 0) {
			lines.push(this.theme.hint("  No settings available"));
			if (this.searchEnabled) {
				this.addHintLine(lines, width);
			}
			return lines;
		}

		const displayItems = this.searchEnabled ? this.filteredItems : this.items;
		if (displayItems.length === 0) {
			lines.push(truncateToWidth(this.theme.hint("  No matching settings"), width));
			this.addHintLine(lines, width);
			return lines;
		}

		// Calculate visible range with scrolling
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), displayItems.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, displayItems.length);

		// Calculate max label width for alignment
		const maxLabelWidth = Math.min(30, Math.max(...this.items.map((item) => visibleWidth(item.label))));

		// Render visible items
		for (let i = startIndex; i < endIndex; i++) {
			const item = displayItems[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? this.theme.cursor : "  ";
			const prefixWidth = visibleWidth(prefix);

			// Pad label to align values
			const labelPadded = item.label + " ".repeat(Math.max(0, maxLabelWidth - visibleWidth(item.label)));
			const labelText = this.theme.label(labelPadded, isSelected);

			// Calculate space for value
			const separator = "  ";
			const usedWidth = prefixWidth + maxLabelWidth + visibleWidth(separator);
			const valueMaxWidth = width - usedWidth - 2;

			const valueText = this.theme.value(truncateToWidth(item.currentValue, valueMaxWidth, ""), isSelected);

			lines.push(truncateToWidth(prefix + labelText + separator + valueText, width));
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < displayItems.length) {
			const scrollText = `  (${this.selectedIndex + 1}/${displayItems.length})`;
			lines.push(this.theme.hint(truncateToWidth(scrollText, width - 2, "")));
		}

		// Add description for selected item
		const selectedItem = displayItems[this.selectedIndex];
		if (selectedItem?.description) {
			lines.push("");
			const wrappedDesc = wrapTextWithAnsi(selectedItem.description, width - 4);
			for (const line of wrappedDesc) {
				lines.push(this.theme.description(`  ${line}`));
			}
		}

		// Add hint
		this.addHintLine(lines, width);

		return lines;
	}

	handleInput(data: string): void {
		// If submenu is active, delegate all input to it
		// The submenu's onCancel (triggered by escape) will call done() which closes it
		if (this.submenuComponent) {
			this.submenuComponent.handleInput?.(data);
			return;
		}

		// Main list input handling
		const kb = getEditorKeybindings();
		const displayItems = this.searchEnabled ? this.filteredItems : this.items;
		if (kb.matches(data, "selectUp")) {
			if (displayItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? displayItems.length - 1 : this.selectedIndex - 1;
		} else if (kb.matches(data, "selectDown")) {
			if (displayItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === displayItems.length - 1 ? 0 : this.selectedIndex + 1;
		} else if (kb.matches(data, "selectConfirm") || data === " ") {
			this.activateItem();
		} else if (kb.matches(data, "selectCancel")) {
			this.onCancel();
		} else if (this.searchEnabled && this.searchInput) {
			const sanitized = data.replace(/ /g, "");
			if (!sanitized) {
				return;
			}
			this.searchInput.handleInput(sanitized);
			this.applyFilter(this.searchInput.getValue());
		}
	}

	/** 激活当前选中项（打开子菜单或切换值） */
	private activateItem(): void {
		const item = this.searchEnabled ? this.filteredItems[this.selectedIndex] : this.items[this.selectedIndex];
		if (!item) return;

		if (item.submenu) {
			// Open submenu, passing current value so it can pre-select correctly
			this.submenuItemIndex = this.selectedIndex;
			this.submenuComponent = item.submenu(item.currentValue, (selectedValue?: string) => {
				if (selectedValue !== undefined) {
					item.currentValue = selectedValue;
					this.onChange(item.id, selectedValue);
				}
				this.closeSubmenu();
			});
		} else if (item.values && item.values.length > 0) {
			// Cycle through values
			const currentIndex = item.values.indexOf(item.currentValue);
			const nextIndex = (currentIndex + 1) % item.values.length;
			const newValue = item.values[nextIndex];
			item.currentValue = newValue;
			this.onChange(item.id, newValue);
		}
	}

	/** 关闭子菜单并恢复选择位置 */
	private closeSubmenu(): void {
		this.submenuComponent = null;
		// Restore selection to the item that opened the submenu
		if (this.submenuItemIndex !== null) {
			this.selectedIndex = this.submenuItemIndex;
			this.submenuItemIndex = null;
		}
	}

	/** 应用模糊搜索过滤 */
	private applyFilter(query: string): void {
		this.filteredItems = fuzzyFilter(this.items, query, (item) => item.label);
		this.selectedIndex = 0;
	}

	private addHintLine(lines: string[], width: number): void {
		lines.push("");
		lines.push(
			truncateToWidth(
				this.theme.hint(
					this.searchEnabled
						? "  Type to search · Enter/Space to change · Esc to cancel"
						: "  Enter/Space to change · Esc to cancel",
				),
				width,
			),
		);
	}
}
