/**
 * @file renderer-registry.ts
 * @description 工具渲染器注册表和渲染辅助函数。
 * 管理工具名称到渲染器的映射，提供 renderHeader 和 renderCollapsibleHeader
 * 辅助函数用于统一工具调用的头部 UI（状态图标、加载动画、折叠展开）。
 */

import { icon } from "@mariozechner/mini-lit";
import { html, type TemplateResult } from "lit";
import type { Ref } from "lit/directives/ref.js";
import { ref } from "lit/directives/ref.js";
import { ChevronsUpDown, ChevronUp, Loader } from "lucide";
import type { ToolRenderer } from "./types.js";

/** 工具渲染器映射表 */
export const toolRenderers = new Map<string, ToolRenderer>();

/**
 * 注册一个自定义工具渲染器。
 * @param toolName - 工具名称
 * @param renderer - 渲染器实例
 */
export function registerToolRenderer(toolName: string, renderer: ToolRenderer): void {
	toolRenderers.set(toolName, renderer);
}

/**
 * 根据工具名称获取对应的渲染器。
 * @param toolName - 工具名称
 * @returns 渲染器实例，若未注册则返回 undefined
 */
export function getToolRenderer(toolName: string): ToolRenderer | undefined {
	return toolRenderers.get(toolName);
}

/**
 * 渲染工具调用的头部行。
 * 完成/错误时左侧显示状态图标，进行中时右侧显示旋转加载图标。
 * @param state - 执行状态（进行中/完成/错误）
 * @param toolIcon - 工具图标组件
 * @param text - 显示文本
 */
export function renderHeader(
	state: "inprogress" | "complete" | "error",
	toolIcon: any,
	text: string | TemplateResult,
): TemplateResult {
	const statusIcon = (iconComponent: any, color: string) =>
		html`<span class="inline-block ${color}">${icon(iconComponent, "sm")}</span>`;

	switch (state) {
		case "inprogress":
			return html`
				<div class="flex items-center justify-between gap-2 text-sm text-muted-foreground">
					<div class="flex items-center gap-2">
						${statusIcon(toolIcon, "text-foreground")}
						${text}
					</div>
					${statusIcon(Loader, "text-foreground animate-spin")}
				</div>
			`;
		case "complete":
			return html`
				<div class="flex items-center gap-2 text-sm text-muted-foreground">
					${statusIcon(toolIcon, "text-green-600 dark:text-green-500")}
					${text}
				</div>
			`;
		case "error":
			return html`
				<div class="flex items-center gap-2 text-sm text-muted-foreground">
					${statusIcon(toolIcon, "text-destructive")}
					${text}
				</div>
			`;
	}
}

/**
 * 渲染可折叠的工具调用头部行。
 * 与 renderHeader 类似，但带有 Chevron 按钮可切换内容区域的显示/隐藏。
 * @param state - 执行状态
 * @param toolIcon - 工具图标组件
 * @param text - 显示文本
 * @param contentRef - 内容区域的 Ref 引用
 * @param chevronRef - Chevron 按钮的 Ref 引用
 * @param defaultExpanded - 是否默认展开
 */
export function renderCollapsibleHeader(
	state: "inprogress" | "complete" | "error",
	toolIcon: any,
	text: string | TemplateResult,
	contentRef: Ref<HTMLElement>,
	chevronRef: Ref<HTMLElement>,
	defaultExpanded = false,
): TemplateResult {
	const statusIcon = (iconComponent: any, color: string) =>
		html`<span class="inline-block ${color}">${icon(iconComponent, "sm")}</span>`;

	const toggleContent = (e: Event) => {
		e.preventDefault();
		const content = contentRef.value;
		const chevron = chevronRef.value;
		if (content && chevron) {
			const isCollapsed = content.classList.contains("max-h-0");
			if (isCollapsed) {
				content.classList.remove("max-h-0");
				content.classList.add("max-h-[2000px]", "mt-3");
				// Show ChevronUp, hide ChevronsUpDown
				const upIcon = chevron.querySelector(".chevron-up");
				const downIcon = chevron.querySelector(".chevrons-up-down");
				if (upIcon && downIcon) {
					upIcon.classList.remove("hidden");
					downIcon.classList.add("hidden");
				}
			} else {
				content.classList.remove("max-h-[2000px]", "mt-3");
				content.classList.add("max-h-0");
				// Show ChevronsUpDown, hide ChevronUp
				const upIcon = chevron.querySelector(".chevron-up");
				const downIcon = chevron.querySelector(".chevrons-up-down");
				if (upIcon && downIcon) {
					upIcon.classList.add("hidden");
					downIcon.classList.remove("hidden");
				}
			}
		}
	};

	const toolIconColor =
		state === "complete"
			? "text-green-600 dark:text-green-500"
			: state === "error"
				? "text-destructive"
				: "text-foreground";

	return html`
		<button @click=${toggleContent} class="flex items-center justify-between gap-2 text-sm text-muted-foreground w-full text-left hover:text-foreground transition-colors cursor-pointer">
			<div class="flex items-center gap-2">
				${state === "inprogress" ? statusIcon(Loader, "text-foreground animate-spin") : ""}
				${statusIcon(toolIcon, toolIconColor)}
				${text}
			</div>
			<span class="inline-block text-muted-foreground" ${ref(chevronRef)}>
				<span class="chevron-up ${defaultExpanded ? "" : "hidden"}">${icon(ChevronUp, "sm")}</span>
				<span class="chevrons-up-down ${defaultExpanded ? "hidden" : ""}">${icon(ChevronsUpDown, "sm")}</span>
			</span>
		</button>
	`;
}
