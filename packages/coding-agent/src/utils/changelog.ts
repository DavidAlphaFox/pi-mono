/**
 * 变更日志解析工具。
 *
 * 该文件提供从 CHANGELOG.md 文件中解析版本条目的功能，
 * 用于在应用启动时展示新版本的变更内容。
 * 支持语义化版本号的解析、版本比较和筛选新条目。
 */

import { existsSync, readFileSync } from "fs";

/**
 * 变更日志条目接口。
 * 表示 CHANGELOG.md 中的一个版本段落。
 */
export interface ChangelogEntry {
	/** 主版本号 */
	major: number;
	/** 次版本号 */
	minor: number;
	/** 补丁版本号 */
	patch: number;
	/** 该版本的变更内容文本 */
	content: string;
}

/**
 * 从 CHANGELOG.md 文件中解析变更日志条目。
 * 扫描以 ## 开头的行作为版本标题，收集其后的内容直到下一个 ## 或文件结束。
 *
 * @param changelogPath - CHANGELOG.md 文件的路径
 * @returns 解析出的变更日志条目数组
 */
export function parseChangelog(changelogPath: string): ChangelogEntry[] {
	if (!existsSync(changelogPath)) {
		return [];
	}

	try {
		const content = readFileSync(changelogPath, "utf-8");
		const lines = content.split("\n");
		const entries: ChangelogEntry[] = [];

		let currentLines: string[] = [];
		let currentVersion: { major: number; minor: number; patch: number } | null = null;

		for (const line of lines) {
			// Check if this is a version header (## [x.y.z] ...)
			if (line.startsWith("## ")) {
				// Save previous entry if exists
				if (currentVersion && currentLines.length > 0) {
					entries.push({
						...currentVersion,
						content: currentLines.join("\n").trim(),
					});
				}

				// Try to parse version from this line
				const versionMatch = line.match(/##\s+\[?(\d+)\.(\d+)\.(\d+)\]?/);
				if (versionMatch) {
					currentVersion = {
						major: Number.parseInt(versionMatch[1], 10),
						minor: Number.parseInt(versionMatch[2], 10),
						patch: Number.parseInt(versionMatch[3], 10),
					};
					currentLines = [line];
				} else {
					// Reset if we can't parse version
					currentVersion = null;
					currentLines = [];
				}
			} else if (currentVersion) {
				// Collect lines for current version
				currentLines.push(line);
			}
		}

		// Save last entry
		if (currentVersion && currentLines.length > 0) {
			entries.push({
				...currentVersion,
				content: currentLines.join("\n").trim(),
			});
		}

		return entries;
	} catch (error) {
		console.error(`Warning: Could not parse changelog: ${error}`);
		return [];
	}
}

/**
 * 比较两个版本号的大小。
 * 按主版本号 > 次版本号 > 补丁版本号的优先级进行比较。
 *
 * @returns 负数表示 v1 < v2，0 表示相等，正数表示 v1 > v2
 */
export function compareVersions(v1: ChangelogEntry, v2: ChangelogEntry): number {
	if (v1.major !== v2.major) return v1.major - v2.major;
	if (v1.minor !== v2.minor) return v1.minor - v2.minor;
	return v1.patch - v2.patch;
}

/**
 * 获取比指定版本更新的变更日志条目。
 * 用于在应用升级后展示新增的变更内容。
 *
 * @param entries - 所有变更日志条目
 * @param lastVersion - 上次查看的版本号字符串（如 "1.2.3"）
 * @returns 比 lastVersion 更新的条目数组
 */
export function getNewEntries(entries: ChangelogEntry[], lastVersion: string): ChangelogEntry[] {
	// Parse lastVersion
	const parts = lastVersion.split(".").map(Number);
	const last: ChangelogEntry = {
		major: parts[0] || 0,
		minor: parts[1] || 0,
		patch: parts[2] || 0,
		content: "",
	};

	return entries.filter((entry) => compareVersions(entry, last) > 0);
}

// 从配置模块中重导出 getChangelogPath，方便外部统一引用
export { getChangelogPath } from "../config.js";
