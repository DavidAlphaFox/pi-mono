/**
 * `pi config` 命令的 TUI 配置选择器模块
 *
 * 职责：
 * - 启动终端 UI（TUI）展示已安装包的资源配置
 * - 允许用户启用/禁用扩展、技能、提示模板和主题
 * - 选择完成或退出后自动清理 TUI 并停止主题监听器
 */

import { ProcessTerminal, TUI } from "@mariozechner/pi-tui";
import type { ResolvedPaths } from "../core/package-manager.js";
import type { SettingsManager } from "../core/settings-manager.js";
import { ConfigSelectorComponent } from "../modes/interactive/components/config-selector.js";
import { initTheme, stopThemeWatcher } from "../modes/interactive/theme/theme.js";

/** 配置选择器的选项 */
export interface ConfigSelectorOptions {
	resolvedPaths: ResolvedPaths;
	settingsManager: SettingsManager;
	cwd: string;
	agentDir: string;
}

/** 显示 TUI 配置选择器，关闭后返回 */
export async function selectConfig(options: ConfigSelectorOptions): Promise<void> {
	// Initialize theme before showing TUI
	initTheme(options.settingsManager.getTheme(), true);

	return new Promise((resolve) => {
		const ui = new TUI(new ProcessTerminal());
		let resolved = false;

		const selector = new ConfigSelectorComponent(
			options.resolvedPaths,
			options.settingsManager,
			options.cwd,
			options.agentDir,
			() => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					stopThemeWatcher();
					resolve();
				}
			},
			() => {
				ui.stop();
				stopThemeWatcher();
				process.exit(0);
			},
			() => ui.requestRender(),
		);

		ui.addChild(selector);
		ui.setFocus(selector.getResourceList());
		ui.start();
	});
}
