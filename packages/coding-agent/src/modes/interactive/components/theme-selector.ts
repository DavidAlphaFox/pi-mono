/**
 * 主题选择器组件。
 *
 * 该文件提供用于在可用主题之间切换的选择器组件，
 * 支持实时预览功能：当光标移动到不同主题时自动应用预览。
 */

import { Container, type SelectItem, SelectList } from "@mariozechner/pi-tui";
import { getAvailableThemes, getSelectListTheme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";

/**
 * 主题选择器组件。
 * 列出所有可用主题，标记当前主题，支持选中时回调和实时预览。
 */
export class ThemeSelectorComponent extends Container {
	private selectList: SelectList;
	private onPreview: (themeName: string) => void;

	constructor(
		currentTheme: string,
		onSelect: (themeName: string) => void,
		onCancel: () => void,
		onPreview: (themeName: string) => void,
	) {
		super();
		this.onPreview = onPreview;

		// Get available themes and create select items
		const themes = getAvailableThemes();
		const themeItems: SelectItem[] = themes.map((name) => ({
			value: name,
			label: name,
			description: name === currentTheme ? "(current)" : undefined,
		}));

		// Add top border
		this.addChild(new DynamicBorder());

		// Create selector
		this.selectList = new SelectList(themeItems, 10, getSelectListTheme());

		// Preselect current theme
		const currentIndex = themes.indexOf(currentTheme);
		if (currentIndex !== -1) {
			this.selectList.setSelectedIndex(currentIndex);
		}

		this.selectList.onSelect = (item) => {
			onSelect(item.value);
		};

		this.selectList.onCancel = () => {
			onCancel();
		};

		this.selectList.onSelectionChange = (item) => {
			this.onPreview(item.value);
		};

		this.addChild(this.selectList);

		// Add bottom border
		this.addChild(new DynamicBorder());
	}

	getSelectList(): SelectList {
		return this.selectList;
	}
}
