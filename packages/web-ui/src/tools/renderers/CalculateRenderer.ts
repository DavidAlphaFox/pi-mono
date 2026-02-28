/**
 * @file CalculateRenderer.ts
 * @description 计算器工具渲染器。
 * 以 "表达式 = 结果" 的格式展示计算过程和结果。
 */

import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html } from "lit";
import { Calculator } from "lucide";
import { i18n } from "../../utils/i18n.js";
import { renderHeader } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";

/** 计算器工具参数 */
interface CalculateParams {
	expression: string;
}

/** 计算器渲染器，展示数学表达式和计算结果 */
export class CalculateRenderer implements ToolRenderer<CalculateParams, undefined> {
	render(params: CalculateParams | undefined, result: ToolResultMessage<undefined> | undefined): ToolRenderResult {
		const state = result ? (result.isError ? "error" : "complete") : "inprogress";

		// Full params + full result
		if (result && params?.expression) {
			const output =
				result.content
					?.filter((c) => c.type === "text")
					.map((c: any) => c.text)
					.join("\n") || "";

			// Error: show expression in header, error below
			if (result.isError) {
				return {
					content: html`
						<div class="space-y-3">
							${renderHeader(state, Calculator, params.expression)}
							<div class="text-sm text-destructive">${output}</div>
						</div>
					`,
					isCustom: false,
				};
			}

			// Success: show expression = result in header
			return { content: renderHeader(state, Calculator, `${params.expression} = ${output}`), isCustom: false };
		}

		// Full params, no result: just show header with expression in it
		if (params?.expression) {
			return {
				content: renderHeader(state, Calculator, `${i18n("Calculating")} ${params.expression}`),
				isCustom: false,
			};
		}

		// Partial params (empty expression), no result
		if (params && !params.expression) {
			return { content: renderHeader(state, Calculator, i18n("Writing expression...")), isCustom: false };
		}

		// No params, no result
		return { content: renderHeader(state, Calculator, i18n("Waiting for expression...")), isCustom: false };
	}
}
