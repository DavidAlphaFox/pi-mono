/**
 * @file ArtifactPill.ts
 * @description 制品文件名标签（Pill）函数式组件。
 * 在消息流中以小型可点击标签展示制品文件名，
 * 点击后在制品面板中打开对应制品。
 */

import { icon } from "@mariozechner/mini-lit";
import { html, type TemplateResult } from "lit";
import { FileCode2 } from "lucide";
import type { ArtifactsPanel } from "./artifacts.js";

/**
 * 渲染制品文件名标签。
 * @param filename - 制品文件名
 * @param artifactsPanel - 可选的制品面板引用，有值时标签可点击
 * @returns Lit 模板结果
 */
export function ArtifactPill(filename: string, artifactsPanel?: ArtifactsPanel): TemplateResult {
	const handleClick = (e: Event) => {
		if (!artifactsPanel) return;
		e.preventDefault();
		e.stopPropagation();
		// openArtifact will show the artifact and call onOpen() to open the panel if needed
		artifactsPanel.openArtifact(filename);
	};

	return html`
		<span
			class="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-muted/50 border border-border rounded ${
				artifactsPanel ? "cursor-pointer hover:bg-muted transition-colors" : ""
			}"
			@click=${artifactsPanel ? handleClick : null}
		>
			${icon(FileCode2, "sm")}
			<span class="text-foreground">${filename}</span>
		</span>
	`;
}
