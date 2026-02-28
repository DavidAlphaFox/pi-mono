/**
 * @file ArtifactElement.ts
 * @description 制品展示元素的抽象基类。
 * 所有制品类型（HTML、SVG、Markdown、Text 等）的展示组件都继承此类。
 * 定义了统一的 content 属性和 getHeaderButtons 接口。
 */

import { LitElement, type TemplateResult } from "lit";

/**
 * 制品元素抽象基类。
 * 使用 Light DOM 以共享全局样式，子类需实现 content 存取器和 getHeaderButtons 方法。
 */
export abstract class ArtifactElement extends LitElement {
	public filename = "";

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this; // light DOM for shared styles
	}

	public abstract get content(): string;
	public abstract set content(value: string);

	abstract getHeaderButtons(): TemplateResult | HTMLElement;
}
