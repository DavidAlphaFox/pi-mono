/**
 * @file FileDownloadRuntimeProvider.ts
 * @description 文件下载运行时提供者。
 * 向沙箱代码暴露 returnDownloadableFile() 函数，
 * 允许沙箱代码创建用户可下载的文件。
 */

import type { SandboxRuntimeProvider } from "./SandboxRuntimeProvider.js";

/** 可下载文件接口 */
export interface DownloadableFile {
	fileName: string;
	content: string | Uint8Array;
	mimeType: string;
}

/**
 * 文件下载运行时提供者。
 * 提供 returnDownloadableFile() 函数用于创建用户下载。
 * 通过此方式返回的文件不会被 LLM 后续访问（一次性下载）。
 * 同时支持在线（发送到扩展）和离线（直接触发浏览器下载）模式。
 */
export class FileDownloadRuntimeProvider implements SandboxRuntimeProvider {
	private files: DownloadableFile[] = [];

	getData(): Record<string, any> {
		// No data needed
		return {};
	}

	getRuntime(): (sandboxId: string) => void {
		return (_sandboxId: string) => {
			(window as any).returnDownloadableFile = async (fileName: string, content: any, mimeType?: string) => {
				let finalContent: any, finalMimeType: string;

				if (content instanceof Blob) {
					const arrayBuffer = await content.arrayBuffer();
					finalContent = new Uint8Array(arrayBuffer);
					finalMimeType = mimeType || content.type || "application/octet-stream";
					if (!mimeType && !content.type) {
						throw new Error(
							"returnDownloadableFile: MIME type is required for Blob content. Please provide a mimeType parameter (e.g., 'image/png').",
						);
					}
				} else if (content instanceof Uint8Array) {
					finalContent = content;
					if (!mimeType) {
						throw new Error(
							"returnDownloadableFile: MIME type is required for Uint8Array content. Please provide a mimeType parameter (e.g., 'image/png').",
						);
					}
					finalMimeType = mimeType;
				} else if (typeof content === "string") {
					finalContent = content;
					finalMimeType = mimeType || "text/plain";
				} else {
					finalContent = JSON.stringify(content, null, 2);
					finalMimeType = mimeType || "application/json";
				}

				// Send to extension if in extension context (online mode)
				if ((window as any).sendRuntimeMessage) {
					const response = await (window as any).sendRuntimeMessage({
						type: "file-returned",
						fileName,
						content: finalContent,
						mimeType: finalMimeType,
					});
					if (response.error) throw new Error(response.error);
				} else {
					// Offline mode: trigger browser download directly
					const blob = new Blob([finalContent instanceof Uint8Array ? finalContent : finalContent], {
						type: finalMimeType,
					});
					const url = URL.createObjectURL(blob);
					const a = document.createElement("a");
					a.href = url;
					a.download = fileName;
					a.click();
					URL.revokeObjectURL(url);
				}
			};
		};
	}

	async handleMessage(message: any, respond: (response: any) => void): Promise<void> {
		if (message.type === "file-returned") {
			// Collect file for caller
			this.files.push({
				fileName: message.fileName,
				content: message.content,
				mimeType: message.mimeType,
			});

			respond({ success: true });
		}
	}

	/**
	 * Get collected files
	 */
	getFiles(): DownloadableFile[] {
		return this.files;
	}

	/**
	 * Reset state for reuse
	 */
	reset(): void {
		this.files = [];
	}

	getDescription(): string {
		return "returnDownloadableFile(filename, content, mimeType?) - Create downloadable file for user (one-time download, not accessible later)";
	}
}
