/**
 * HTML 导出模块
 *
 * 本文件实现了将会话导出为独立 HTML 文件的功能，包括：
 * 1. 从会话管理器读取会话数据并序列化为 Base64 JSON
 * 2. 主题变量注入：从当前主题生成 CSS 自定义属性
 * 3. 背景颜色推导：根据主题的 userMessageBg 自动计算页面/卡片/信息区背景色
 * 4. 自定义工具的预渲染：调用工具的 TUI 渲染器并转换为 HTML
 * 5. 模板组装：将 CSS、JS（含 marked.js 和 highlight.js）嵌入到 HTML 模板中
 * 6. 支持两种导出入口：从活动会话导出和从文件导出
 */

import type { AgentState } from "@mariozechner/pi-agent-core";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { APP_NAME, getExportTemplateDir } from "../../config.js";
import { getResolvedThemeColors, getThemeExportColors } from "../../modes/interactive/theme/theme.js";
import type { ToolInfo } from "../extensions/types.js";
import type { SessionEntry } from "../session-manager.js";
import { SessionManager } from "../session-manager.js";

/**
 * 自定义工具的 HTML 渲染接口。
 * 由 agent-session 用于预渲染扩展工具的输出。
 */
export interface ToolHtmlRenderer {
	/** 将工具调用渲染为 HTML，无自定义渲染器时返回 undefined */
	renderCall(toolName: string, args: unknown): string | undefined;
	/** 将工具结果渲染为 HTML，无自定义渲染器时返回 undefined */
	renderResult(
		toolName: string,
		result: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
		details: unknown,
		isError: boolean,
	): string | undefined;
}

/** 自定义工具的预渲染 HTML（调用和结果） */
interface RenderedToolHtml {
	callHtml?: string;
	resultHtml?: string;
}

/** 导出选项 */
export interface ExportOptions {
	/** 输出文件路径 */
	outputPath?: string;
	/** 主题名称 */
	themeName?: string;
	/** 可选的自定义工具渲染器 */
	toolRenderer?: ToolHtmlRenderer;
}

/** 将颜色字符串解析为 RGB 值，支持 hex（#RRGGBB）和 rgb(r,g,b) 格式 */
function parseColor(color: string): { r: number; g: number; b: number } | undefined {
	const hexMatch = color.match(/^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
	if (hexMatch) {
		return {
			r: Number.parseInt(hexMatch[1], 16),
			g: Number.parseInt(hexMatch[2], 16),
			b: Number.parseInt(hexMatch[3], 16),
		};
	}
	const rgbMatch = color.match(/^rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
	if (rgbMatch) {
		return {
			r: Number.parseInt(rgbMatch[1], 10),
			g: Number.parseInt(rgbMatch[2], 10),
			b: Number.parseInt(rgbMatch[3], 10),
		};
	}
	return undefined;
}

/** 计算颜色的相对亮度（0-1，越大越亮） */
function getLuminance(r: number, g: number, b: number): number {
	const toLinear = (c: number) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** 调整颜色亮度。factor > 1 变亮，< 1 变暗 */
function adjustBrightness(color: string, factor: number): string {
	const parsed = parseColor(color);
	if (!parsed) return color;
	const adjust = (c: number) => Math.min(255, Math.max(0, Math.round(c * factor)));
	return `rgb(${adjust(parsed.r)}, ${adjust(parsed.g)}, ${adjust(parsed.b)})`;
}

/** 从基础颜色（如 userMessageBg）推导导出页面的背景颜色 */
function deriveExportColors(baseColor: string): { pageBg: string; cardBg: string; infoBg: string } {
	const parsed = parseColor(baseColor);
	if (!parsed) {
		return {
			pageBg: "rgb(24, 24, 30)",
			cardBg: "rgb(30, 30, 36)",
			infoBg: "rgb(60, 55, 40)",
		};
	}

	const luminance = getLuminance(parsed.r, parsed.g, parsed.b);
	const isLight = luminance > 0.5;

	if (isLight) {
		return {
			pageBg: adjustBrightness(baseColor, 0.96),
			cardBg: baseColor,
			infoBg: `rgb(${Math.min(255, parsed.r + 10)}, ${Math.min(255, parsed.g + 5)}, ${Math.max(0, parsed.b - 20)})`,
		};
	}
	return {
		pageBg: adjustBrightness(baseColor, 0.7),
		cardBg: adjustBrightness(baseColor, 0.85),
		infoBg: `rgb(${Math.min(255, parsed.r + 20)}, ${Math.min(255, parsed.g + 15)}, ${parsed.b})`,
	};
}

/**
 * 从主题颜色生成 CSS 自定义属性声明。
 */
function generateThemeVars(themeName?: string): string {
	const colors = getResolvedThemeColors(themeName);
	const lines: string[] = [];
	for (const [key, value] of Object.entries(colors)) {
		lines.push(`--${key}: ${value};`);
	}

	// Use explicit theme export colors if available, otherwise derive from userMessageBg
	const themeExport = getThemeExportColors(themeName);
	const userMessageBg = colors.userMessageBg || "#343541";
	const derivedColors = deriveExportColors(userMessageBg);

	lines.push(`--exportPageBg: ${themeExport.pageBg ?? derivedColors.pageBg};`);
	lines.push(`--exportCardBg: ${themeExport.cardBg ?? derivedColors.cardBg};`);
	lines.push(`--exportInfoBg: ${themeExport.infoBg ?? derivedColors.infoBg};`);

	return lines.join("\n      ");
}

interface SessionData {
	header: ReturnType<SessionManager["getHeader"]>;
	entries: ReturnType<SessionManager["getEntries"]>;
	leafId: string | null;
	systemPrompt?: string;
	tools?: ToolInfo[];
	/** Pre-rendered HTML for custom tool calls/results, keyed by tool call ID */
	renderedTools?: Record<string, RenderedToolHtml>;
}

/**
 * 两种导出函数共享的核心 HTML 生成逻辑。
 */
function generateHtml(sessionData: SessionData, themeName?: string): string {
	const templateDir = getExportTemplateDir();
	const template = readFileSync(join(templateDir, "template.html"), "utf-8");
	const templateCss = readFileSync(join(templateDir, "template.css"), "utf-8");
	const templateJs = readFileSync(join(templateDir, "template.js"), "utf-8");
	const markedJs = readFileSync(join(templateDir, "vendor", "marked.min.js"), "utf-8");
	const hljsJs = readFileSync(join(templateDir, "vendor", "highlight.min.js"), "utf-8");

	const themeVars = generateThemeVars(themeName);
	const colors = getResolvedThemeColors(themeName);
	const exportColors = deriveExportColors(colors.userMessageBg || "#343541");
	const bodyBg = exportColors.pageBg;
	const containerBg = exportColors.cardBg;
	const infoBg = exportColors.infoBg;

	// Base64 encode session data to avoid escaping issues
	const sessionDataBase64 = Buffer.from(JSON.stringify(sessionData)).toString("base64");

	// Build the CSS with theme variables injected
	const css = templateCss
		.replace("{{THEME_VARS}}", themeVars)
		.replace("{{BODY_BG}}", bodyBg)
		.replace("{{CONTAINER_BG}}", containerBg)
		.replace("{{INFO_BG}}", infoBg);

	return template
		.replace("{{CSS}}", css)
		.replace("{{JS}}", templateJs)
		.replace("{{SESSION_DATA}}", sessionDataBase64)
		.replace("{{MARKED_JS}}", markedJs)
		.replace("{{HIGHLIGHT_JS}}", hljsJs);
}

/** 在 template.js 中有自定义渲染逻辑的内置工具名称 */
const BUILTIN_TOOLS = new Set(["bash", "read", "write", "edit", "ls", "find", "grep"]);

/**
 * 使用工具的 TUI 渲染器预渲染自定义工具为 HTML。
 */
function preRenderCustomTools(
	entries: SessionEntry[],
	toolRenderer: ToolHtmlRenderer,
): Record<string, RenderedToolHtml> {
	const renderedTools: Record<string, RenderedToolHtml> = {};

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message;

		// Find tool calls in assistant messages
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "toolCall" && !BUILTIN_TOOLS.has(block.name)) {
					const callHtml = toolRenderer.renderCall(block.name, block.arguments);
					if (callHtml) {
						renderedTools[block.id] = { callHtml };
					}
				}
			}
		}

		// Find tool results
		if (msg.role === "toolResult" && msg.toolCallId) {
			const toolName = msg.toolName || "";
			// Only render if we have a pre-rendered call OR it's not a built-in tool
			const existing = renderedTools[msg.toolCallId];
			if (existing || !BUILTIN_TOOLS.has(toolName)) {
				const resultHtml = toolRenderer.renderResult(toolName, msg.content, msg.details, msg.isError || false);
				if (resultHtml) {
					renderedTools[msg.toolCallId] = {
						...existing,
						resultHtml,
					};
				}
			}
		}
	}

	return renderedTools;
}

/**
 * 使用 SessionManager 和 AgentState 将会话导出为 HTML。
 * 由 TUI 的 /export 命令使用。
 */
export async function exportSessionToHtml(
	sm: SessionManager,
	state?: AgentState,
	options?: ExportOptions | string,
): Promise<string> {
	const opts: ExportOptions = typeof options === "string" ? { outputPath: options } : options || {};

	const sessionFile = sm.getSessionFile();
	if (!sessionFile) {
		throw new Error("Cannot export in-memory session to HTML");
	}
	if (!existsSync(sessionFile)) {
		throw new Error("Nothing to export yet - start a conversation first");
	}

	const entries = sm.getEntries();

	// Pre-render custom tools if a tool renderer is provided
	let renderedTools: Record<string, RenderedToolHtml> | undefined;
	if (opts.toolRenderer) {
		renderedTools = preRenderCustomTools(entries, opts.toolRenderer);
		// Only include if we actually rendered something
		if (Object.keys(renderedTools).length === 0) {
			renderedTools = undefined;
		}
	}

	const sessionData: SessionData = {
		header: sm.getHeader(),
		entries,
		leafId: sm.getLeafId(),
		systemPrompt: state?.systemPrompt,
		tools: state?.tools?.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
		renderedTools,
	};

	const html = generateHtml(sessionData, opts.themeName);

	let outputPath = opts.outputPath;
	if (!outputPath) {
		const sessionBasename = basename(sessionFile, ".jsonl");
		outputPath = `${APP_NAME}-session-${sessionBasename}.html`;
	}

	writeFileSync(outputPath, html, "utf8");
	return outputPath;
}

/**
 * 从会话文件导出为 HTML（独立模式，不需要 AgentState）。
 * 由 CLI 用于导出任意会话文件。
 */
export async function exportFromFile(inputPath: string, options?: ExportOptions | string): Promise<string> {
	const opts: ExportOptions = typeof options === "string" ? { outputPath: options } : options || {};

	if (!existsSync(inputPath)) {
		throw new Error(`File not found: ${inputPath}`);
	}

	const sm = SessionManager.open(inputPath);

	const sessionData: SessionData = {
		header: sm.getHeader(),
		entries: sm.getEntries(),
		leafId: sm.getLeafId(),
		systemPrompt: undefined,
		tools: undefined,
	};

	const html = generateHtml(sessionData, opts.themeName);

	let outputPath = opts.outputPath;
	if (!outputPath) {
		const inputBasename = basename(inputPath, ".jsonl");
		outputPath = `${APP_NAME}-session-${inputBasename}.html`;
	}

	writeFileSync(outputPath, html, "utf8");
	return outputPath;
}
