/**
 * 路径处理工具函数
 *
 * 本文件提供了路径解析和标准化的工具函数，功能包括：
 * 1. Unicode 特殊空格标准化为普通空格
 * 2. 波浪号（~）展开为用户主目录
 * 3. "@" 前缀路径的标准化
 * 4. 相对路径解析为绝对路径（基于工作目录）
 * 5. macOS 文件名兼容性处理（AM/PM 空格、NFD 编码、弯引号）
 */

import { accessSync, constants } from "node:fs";
import * as os from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
/** 窄不间断空格，macOS 截图文件名中 AM/PM 前使用此字符 */
const NARROW_NO_BREAK_SPACE = "\u202F";

/** 将 Unicode 特殊空格标准化为普通 ASCII 空格 */
function normalizeUnicodeSpaces(str: string): string {
	return str.replace(UNICODE_SPACES, " ");
}

/** 尝试修复 macOS 截图路径中 AM/PM 前的空格（普通空格 -> 窄不间断空格） */
function tryMacOSScreenshotPath(filePath: string): string {
	return filePath.replace(/ (AM|PM)\./g, `${NARROW_NO_BREAK_SPACE}$1.`);
}

/** 尝试将路径转换为 NFD（分解形式），因为 macOS 以 NFD 形式存储文件名 */
function tryNFDVariant(filePath: string): string {
	return filePath.normalize("NFD");
}

/** 尝试将直引号替换为弯引号（macOS 截图名称如 "Capture d'écran" 使用 U+2019） */
function tryCurlyQuoteVariant(filePath: string): string {
	return filePath.replace(/'/g, "\u2019");
}

/** 检查文件是否存在 */
function fileExists(filePath: string): boolean {
	try {
		accessSync(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

/** 去除路径的 "@" 前缀（如果有） */
function normalizeAtPrefix(filePath: string): string {
	return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

/**
 * 展开路径：标准化 Unicode 空格、去除 "@" 前缀、展开波浪号（~）为用户主目录。
 */
export function expandPath(filePath: string): string {
	const normalized = normalizeUnicodeSpaces(normalizeAtPrefix(filePath));
	if (normalized === "~") {
		return os.homedir();
	}
	if (normalized.startsWith("~/")) {
		return os.homedir() + normalized.slice(1);
	}
	return normalized;
}

/**
 * 将路径解析为绝对路径（基于给定的工作目录）。
 * 支持波浪号展开和绝对路径直接返回。
 */
export function resolveToCwd(filePath: string, cwd: string): string {
	const expanded = expandPath(filePath);
	if (isAbsolute(expanded)) {
		return expanded;
	}
	return resolvePath(cwd, expanded);
}

/**
 * 解析文件读取路径，带 macOS 兼容性处理。
 * 先尝试原始路径，如果文件不存在则依次尝试 macOS 截图路径变体：
 * AM/PM 空格变体 -> NFD 变体 -> 弯引号变体 -> NFD+弯引号组合变体。
 */
export function resolveReadPath(filePath: string, cwd: string): string {
	const resolved = resolveToCwd(filePath, cwd);

	if (fileExists(resolved)) {
		return resolved;
	}

	// Try macOS AM/PM variant (narrow no-break space before AM/PM)
	const amPmVariant = tryMacOSScreenshotPath(resolved);
	if (amPmVariant !== resolved && fileExists(amPmVariant)) {
		return amPmVariant;
	}

	// Try NFD variant (macOS stores filenames in NFD form)
	const nfdVariant = tryNFDVariant(resolved);
	if (nfdVariant !== resolved && fileExists(nfdVariant)) {
		return nfdVariant;
	}

	// Try curly quote variant (macOS uses U+2019 in screenshot names)
	const curlyVariant = tryCurlyQuoteVariant(resolved);
	if (curlyVariant !== resolved && fileExists(curlyVariant)) {
		return curlyVariant;
	}

	// Try combined NFD + curly quote (for French macOS screenshots like "Capture d'écran")
	const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
	if (nfdCurlyVariant !== resolved && fileExists(nfdCurlyVariant)) {
		return nfdCurlyVariant;
	}

	return resolved;
}
