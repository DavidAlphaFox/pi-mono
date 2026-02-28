/**
 * 编辑工具的差异计算工具集
 *
 * 本文件包含编辑工具共享的差异计算和文本处理工具函数，功能包括：
 * 1. 换行符检测、标准化和恢复（支持 CRLF/LF）
 * 2. 模糊匹配的文本标准化（处理尾随空白、Unicode 引号/破折号/特殊空格）
 * 3. 精确匹配优先的模糊文本查找（fuzzyFindText）
 * 4. UTF-8 BOM 标记的剥离和恢复
 * 5. 带行号和上下文的 unified diff 生成
 * 6. 编辑预览的差异计算（不实际应用修改）
 *
 * 被 edit.ts（执行编辑）和 tool-execution.ts（预览渲染）共同使用。
 */

import * as Diff from "diff";
import { constants } from "fs";
import { access, readFile } from "fs/promises";
import { resolveToCwd } from "./path-utils.js";

/**
 * 检测文件内容使用的换行符类型。
 * 如果先出现 CRLF（\r\n）则返回 "\r\n"，否则返回 "\n"。
 */
export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

/** 将所有换行符标准化为 LF（\n） */
export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** 将 LF 换行符恢复为指定的换行符类型 */
export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * 对文本进行模糊匹配标准化处理，依次应用以下变换：
 * - 去除每行的尾随空白
 * - 将 Unicode 弯引号标准化为 ASCII 引号
 * - 将 Unicode 破折号/连字符标准化为 ASCII 连字符
 * - 将 Unicode 特殊空格标准化为普通空格
 */
export function normalizeForFuzzyMatch(text: string): string {
	return (
		text
			// Strip trailing whitespace per line
			.split("\n")
			.map((line) => line.trimEnd())
			.join("\n")
			// Smart single quotes → '
			.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
			// Smart double quotes → "
			.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
			// Various dashes/hyphens → -
			// U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
			// U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus
			.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
			// Special spaces → regular space
			// U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP,
			// U+205F medium math space, U+3000 ideographic space
			.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
	);
}

/** 模糊匹配结果 */
export interface FuzzyMatchResult {
	/** 是否找到匹配 */
	found: boolean;
	/** 匹配起始位置的索引（在 contentForReplacement 中的位置） */
	index: number;
	/** 匹配文本的长度 */
	matchLength: number;
	/** 是否使用了模糊匹配（false 表示精确匹配） */
	usedFuzzyMatch: boolean;
	/**
	 * 用于替换操作的内容。
	 * 精确匹配时为原始内容，模糊匹配时为标准化后的内容。
	 */
	contentForReplacement: string;
}

/**
 * 在内容中查找旧文本，优先尝试精确匹配，失败后尝试模糊匹配。
 * 使用模糊匹配时，返回的 contentForReplacement 是经过标准化的内容
 * （去除尾随空白，Unicode 引号/破折号标准化为 ASCII）。
 */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
	// Try exact match first
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) {
		return {
			found: true,
			index: exactIndex,
			matchLength: oldText.length,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	// Try fuzzy match - work entirely in normalized space
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);

	if (fuzzyIndex === -1) {
		return {
			found: false,
			index: -1,
			matchLength: 0,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	// When fuzzy matching, we work in the normalized space for replacement.
	// This means the output will have normalized whitespace/quotes/dashes,
	// which is acceptable since we're fixing minor formatting differences anyway.
	return {
		found: true,
		index: fuzzyIndex,
		matchLength: fuzzyOldText.length,
		usedFuzzyMatch: true,
		contentForReplacement: fuzzyContent,
	};
}

/** 剥离 UTF-8 BOM 标记（如果存在），返回 BOM 标记和去除 BOM 后的文本 */
export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

/**
 * 生成带行号和上下文的 unified diff 字符串。
 * 返回 diff 字符串和新文件中第一个变更的行号。
 */
export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			// Capture the first changed line (in the new file)
			if (firstChangedLine === undefined) {
				firstChangedLine = newLineNum;
			}

			// Show the change
			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					// removed
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			// Context lines - only show a few before/after changes
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);

			if (lastWasChange || nextPartIsChange) {
				// Show context
				let linesToShow = raw;
				let skipStart = 0;
				let skipEnd = 0;

				if (!lastWasChange) {
					// Show only last N lines as leading context
					skipStart = Math.max(0, raw.length - contextLines);
					linesToShow = raw.slice(skipStart);
				}

				if (!nextPartIsChange && linesToShow.length > contextLines) {
					// Show only first N lines as trailing context
					skipEnd = linesToShow.length - contextLines;
					linesToShow = linesToShow.slice(0, contextLines);
				}

				// Add ellipsis if we skipped lines at start
				if (skipStart > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					// Update line numbers for the skipped leading context
					oldLineNum += skipStart;
					newLineNum += skipStart;
				}

				for (const line of linesToShow) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}

				// Add ellipsis if we skipped lines at end
				if (skipEnd > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					// Update line numbers for the skipped trailing context
					oldLineNum += skipEnd;
					newLineNum += skipEnd;
				}
			} else {
				// Skip these context lines entirely
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return { diff: output.join("\n"), firstChangedLine };
}

/** 编辑差异计算的成功结果 */
export interface EditDiffResult {
	/** unified diff 字符串 */
	diff: string;
	/** 新文件中第一个变更的行号 */
	firstChangedLine: number | undefined;
}

/** 编辑差异计算的错误结果 */
export interface EditDiffError {
	/** 错误描述信息 */
	error: string;
}

/**
 * 计算编辑操作的差异但不实际应用修改。
 * 用于 TUI 在工具执行前的预览渲染。
 */
export async function computeEditDiff(
	path: string,
	oldText: string,
	newText: string,
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	const absolutePath = resolveToCwd(path, cwd);

	try {
		// Check if file exists and is readable
		try {
			await access(absolutePath, constants.R_OK);
		} catch {
			return { error: `File not found: ${path}` };
		}

		// Read the file
		const rawContent = await readFile(absolutePath, "utf-8");

		// Strip BOM before matching (LLM won't include invisible BOM in oldText)
		const { text: content } = stripBom(rawContent);

		const normalizedContent = normalizeToLF(content);
		const normalizedOldText = normalizeToLF(oldText);
		const normalizedNewText = normalizeToLF(newText);

		// Find the old text using fuzzy matching (tries exact match first, then fuzzy)
		const matchResult = fuzzyFindText(normalizedContent, normalizedOldText);

		if (!matchResult.found) {
			return {
				error: `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
			};
		}

		// Count occurrences using fuzzy-normalized content for consistency
		const fuzzyContent = normalizeForFuzzyMatch(normalizedContent);
		const fuzzyOldText = normalizeForFuzzyMatch(normalizedOldText);
		const occurrences = fuzzyContent.split(fuzzyOldText).length - 1;

		if (occurrences > 1) {
			return {
				error: `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
			};
		}

		// Compute the new content using the matched position
		// When fuzzy matching was used, contentForReplacement is the normalized version
		const baseContent = matchResult.contentForReplacement;
		const newContent =
			baseContent.substring(0, matchResult.index) +
			normalizedNewText +
			baseContent.substring(matchResult.index + matchResult.matchLength);

		// Check if it would actually change anything
		if (baseContent === newContent) {
			return {
				error: `No changes would be made to ${path}. The replacement produces identical content.`,
			};
		}

		// Generate the diff
		return generateDiffString(baseContent, newContent);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}
