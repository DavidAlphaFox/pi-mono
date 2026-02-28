/**
 * 提示词模板加载和参数替换模块
 *
 * 职责：
 * - 从全局目录、项目目录和显式路径加载 .md 提示词模板
 * - 解析 frontmatter 提取名称和描述
 * - 支持 bash 风格的参数替换（$1、$@、$ARGUMENTS、${@:N}、${@:N:L}）
 * - 解析引号包裹的命令参数
 * - 在用户输入中展开匹配的模板
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { basename, isAbsolute, join, resolve, sep } from "path";
import { CONFIG_DIR_NAME, getPromptsDir } from "../config.js";
import { parseFrontmatter } from "../utils/frontmatter.js";

/** 从 markdown 文件加载的提示词模板 */
export interface PromptTemplate {
	name: string;
	description: string;
	content: string;
	source: string; // "user", "project", or "path"
	filePath: string; // Absolute path to the template file
}

/**
 * 解析命令参数，尊重引号字符串（bash 风格）
 * 返回参数数组
 */
export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;

	for (let i = 0; i < argsString.length; i++) {
		const char = argsString[i];

		if (inQuote) {
			if (char === inQuote) {
				inQuote = null;
			} else {
				current += char;
			}
		} else if (char === '"' || char === "'") {
			inQuote = char;
		} else if (char === " " || char === "\t") {
			if (current) {
				args.push(current);
				current = "";
			}
		} else {
			current += char;
		}
	}

	if (current) {
		args.push(current);
	}

	return args;
}

/**
 * 替换模板内容中的参数占位符
 * 支持：
 * - $1, $2, ... 位置参数
 * - $@ 和 $ARGUMENTS 所有参数
 * - ${@:N} 从第 N 个开始的参数（bash 风格切片）
 * - ${@:N:L} 从第 N 个开始的 L 个参数
 *
 * 注意：替换仅在模板字符串上进行，参数值中的模式不会被递归替换
 */
export function substituteArgs(content: string, args: string[]): string {
	let result = content;

	// Replace $1, $2, etc. with positional args FIRST (before wildcards)
	// This prevents wildcard replacement values containing $<digit> patterns from being re-substituted
	result = result.replace(/\$(\d+)/g, (_, num) => {
		const index = parseInt(num, 10) - 1;
		return args[index] ?? "";
	});

	// Replace ${@:start} or ${@:start:length} with sliced args (bash-style)
	// Process BEFORE simple $@ to avoid conflicts
	result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, startStr, lengthStr) => {
		let start = parseInt(startStr, 10) - 1; // Convert to 0-indexed (user provides 1-indexed)
		// Treat 0 as 1 (bash convention: args start at 1)
		if (start < 0) start = 0;

		if (lengthStr) {
			const length = parseInt(lengthStr, 10);
			return args.slice(start, start + length).join(" ");
		}
		return args.slice(start).join(" ");
	});

	// Pre-compute all args joined (optimization)
	const allArgs = args.join(" ");

	// Replace $ARGUMENTS with all args joined (new syntax, aligns with Claude, Codex, OpenCode)
	result = result.replace(/\$ARGUMENTS/g, allArgs);

	// Replace $@ with all args joined (existing syntax)
	result = result.replace(/\$@/g, allArgs);

	return result;
}

function loadTemplateFromFile(filePath: string, source: string, sourceLabel: string): PromptTemplate | null {
	try {
		const rawContent = readFileSync(filePath, "utf-8");
		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(rawContent);

		const name = basename(filePath).replace(/\.md$/, "");

		// Get description from frontmatter or first non-empty line
		let description = frontmatter.description || "";
		if (!description) {
			const firstLine = body.split("\n").find((line) => line.trim());
			if (firstLine) {
				// Truncate if too long
				description = firstLine.slice(0, 60);
				if (firstLine.length > 60) description += "...";
			}
		}

		// Append source to description
		description = description ? `${description} ${sourceLabel}` : sourceLabel;

		return {
			name,
			description,
			content: body,
			source,
			filePath,
		};
	} catch {
		return null;
	}
}

/**
 * Scan a directory for .md files (non-recursive) and load them as prompt templates.
 */
function loadTemplatesFromDir(dir: string, source: string, sourceLabel: string): PromptTemplate[] {
	const templates: PromptTemplate[] = [];

	if (!existsSync(dir)) {
		return templates;
	}

	try {
		const entries = readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = join(dir, entry.name);

			// For symlinks, check if they point to a file
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isFile = stats.isFile();
				} catch {
					// Broken symlink, skip it
					continue;
				}
			}

			if (isFile && entry.name.endsWith(".md")) {
				const template = loadTemplateFromFile(fullPath, source, sourceLabel);
				if (template) {
					templates.push(template);
				}
			}
		}
	} catch {
		return templates;
	}

	return templates;
}

/** 提示词模板加载选项 */
export interface LoadPromptTemplatesOptions {
	/** Working directory for project-local templates. Default: process.cwd() */
	cwd?: string;
	/** Agent config directory for global templates. Default: from getPromptsDir() */
	agentDir?: string;
	/** Explicit prompt template paths (files or directories) */
	promptPaths?: string[];
	/** Include default prompt directories. Default: true */
	includeDefaults?: boolean;
}

function normalizePath(input: string): string {
	const trimmed = input.trim();
	if (trimmed === "~") return homedir();
	if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
	if (trimmed.startsWith("~")) return join(homedir(), trimmed.slice(1));
	return trimmed;
}

function resolvePromptPath(p: string, cwd: string): string {
	const normalized = normalizePath(p);
	return isAbsolute(normalized) ? normalized : resolve(cwd, normalized);
}

function buildPathSourceLabel(p: string): string {
	const base = basename(p).replace(/\.md$/, "") || "path";
	return `(path:${base})`;
}

/**
 * 从所有位置加载提示词模板：
 * 1. 全局：agentDir/prompts/
 * 2. 项目：cwd/{CONFIG_DIR_NAME}/prompts/
 * 3. 显式路径
 */
export function loadPromptTemplates(options: LoadPromptTemplatesOptions = {}): PromptTemplate[] {
	const resolvedCwd = options.cwd ?? process.cwd();
	const resolvedAgentDir = options.agentDir ?? getPromptsDir();
	const promptPaths = options.promptPaths ?? [];
	const includeDefaults = options.includeDefaults ?? true;

	const templates: PromptTemplate[] = [];

	if (includeDefaults) {
		// 1. Load global templates from agentDir/prompts/
		// Note: if agentDir is provided, it should be the agent dir, not the prompts dir
		const globalPromptsDir = options.agentDir ? join(options.agentDir, "prompts") : resolvedAgentDir;
		templates.push(...loadTemplatesFromDir(globalPromptsDir, "user", "(user)"));

		// 2. Load project templates from cwd/{CONFIG_DIR_NAME}/prompts/
		const projectPromptsDir = resolve(resolvedCwd, CONFIG_DIR_NAME, "prompts");
		templates.push(...loadTemplatesFromDir(projectPromptsDir, "project", "(project)"));
	}

	const userPromptsDir = options.agentDir ? join(options.agentDir, "prompts") : resolvedAgentDir;
	const projectPromptsDir = resolve(resolvedCwd, CONFIG_DIR_NAME, "prompts");

	const isUnderPath = (target: string, root: string): boolean => {
		const normalizedRoot = resolve(root);
		if (target === normalizedRoot) {
			return true;
		}
		const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
		return target.startsWith(prefix);
	};

	const getSourceInfo = (resolvedPath: string): { source: string; label: string } => {
		if (!includeDefaults) {
			if (isUnderPath(resolvedPath, userPromptsDir)) {
				return { source: "user", label: "(user)" };
			}
			if (isUnderPath(resolvedPath, projectPromptsDir)) {
				return { source: "project", label: "(project)" };
			}
		}
		return { source: "path", label: buildPathSourceLabel(resolvedPath) };
	};

	// 3. Load explicit prompt paths
	for (const rawPath of promptPaths) {
		const resolvedPath = resolvePromptPath(rawPath, resolvedCwd);
		if (!existsSync(resolvedPath)) {
			continue;
		}

		try {
			const stats = statSync(resolvedPath);
			const { source, label } = getSourceInfo(resolvedPath);
			if (stats.isDirectory()) {
				templates.push(...loadTemplatesFromDir(resolvedPath, source, label));
			} else if (stats.isFile() && resolvedPath.endsWith(".md")) {
				const template = loadTemplateFromFile(resolvedPath, source, label);
				if (template) {
					templates.push(template);
				}
			}
		} catch {
			// Ignore read failures
		}
	}

	return templates;
}

/**
 * 展开提示词模板 - 匹配模板名称时返回展开内容，否则返回原文
 */
export function expandPromptTemplate(text: string, templates: PromptTemplate[]): string {
	if (!text.startsWith("/")) return text;

	const spaceIndex = text.indexOf(" ");
	const templateName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
	const argsString = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

	const template = templates.find((t) => t.name === templateName);
	if (template) {
		const args = parseCommandArgs(argsString);
		return substituteArgs(template.content, args);
	}

	return text;
}
