/**
 * @file AttachmentsRuntimeProvider.ts
 * @description 附件运行时提供者。
 * 可选的提供者，当用户上传了附件时向沙箱代码提供文件访问 API。
 * 附件数据为只读快照，无需消息通信。
 */

import { ATTACHMENTS_RUNTIME_DESCRIPTION } from "../../prompts/prompts.js";
import type { Attachment } from "../../utils/attachment-utils.js";
import type { SandboxRuntimeProvider } from "./SandboxRuntimeProvider.js";

/**
 * 附件运行时提供者。
 * 向沙箱代码暴露 listAttachments、readTextAttachment、readBinaryAttachment 函数，
 * 数据直接从 window.attachments 中读取，无需异步消息通信。
 */
export class AttachmentsRuntimeProvider implements SandboxRuntimeProvider {
	constructor(private attachments: Attachment[]) {}

	getData(): Record<string, any> {
		const attachmentsData = this.attachments.map((a) => ({
			id: a.id,
			fileName: a.fileName,
			mimeType: a.mimeType,
			size: a.size,
			content: a.content,
			extractedText: a.extractedText,
		}));

		return { attachments: attachmentsData };
	}

	getRuntime(): (sandboxId: string) => void {
		// This function will be stringified, so no external references!
		// These functions read directly from window.attachments
		// Works both online AND offline (no messaging needed!)
		return (_sandboxId: string) => {
			(window as any).listAttachments = () =>
				((window as any).attachments || []).map((a: any) => ({
					id: a.id,
					fileName: a.fileName,
					mimeType: a.mimeType,
					size: a.size,
				}));

			(window as any).readTextAttachment = (attachmentId: string) => {
				const a = ((window as any).attachments || []).find((x: any) => x.id === attachmentId);
				if (!a) throw new Error(`Attachment not found: ${attachmentId}`);
				if (a.extractedText) return a.extractedText;
				try {
					return atob(a.content);
				} catch {
					throw new Error(`Failed to decode text content for: ${attachmentId}`);
				}
			};

			(window as any).readBinaryAttachment = (attachmentId: string) => {
				const a = ((window as any).attachments || []).find((x: any) => x.id === attachmentId);
				if (!a) throw new Error(`Attachment not found: ${attachmentId}`);
				const bin = atob(a.content);
				const bytes = new Uint8Array(bin.length);
				for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
				return bytes;
			};
		};
	}

	getDescription(): string {
		return ATTACHMENTS_RUNTIME_DESCRIPTION;
	}
}
