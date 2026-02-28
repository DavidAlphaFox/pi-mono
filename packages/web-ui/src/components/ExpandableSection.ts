import { icon } from "@mariozechner/mini-lit";
import { html, LitElement, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { ChevronDown, ChevronRight } from "lucide";

/**
 * @file ExpandableSection.ts
 * @description 可折叠区域组件（<expandable-section>）。
 * 通用的可展开/折叠区域，用于工具渲染器等场景。
 * 在 connectedCallback 中捕获子节点，在展开时重新渲染。
 */

/**
 * 可折叠区域 Web Component。
 * 点击摘要行可展开/折叠详细内容区域，使用 Chevron 图标指示状态。
 */
@customElement("expandable-section")
export class ExpandableSection extends LitElement {
	@property() summary!: string;
	@property({ type: Boolean }) defaultExpanded = false;
	@state() private expanded = false;
	private capturedChildren: Node[] = [];

	protected createRenderRoot() {
		return this; // light DOM
	}

	override connectedCallback() {
		super.connectedCallback();
		// Capture children before first render
		this.capturedChildren = Array.from(this.childNodes);
		// Clear children (we'll re-insert them in render)
		this.innerHTML = "";
		this.expanded = this.defaultExpanded;
	}

	override render(): TemplateResult {
		return html`
			<div>
				<button
					@click=${() => {
						this.expanded = !this.expanded;
					}}
					class="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors w-full text-left"
				>
					${icon(this.expanded ? ChevronDown : ChevronRight, "sm")}
					<span>${this.summary}</span>
				</button>
				${this.expanded ? html`<div class="mt-2">${this.capturedChildren}</div>` : ""}
			</div>
		`;
	}
}
