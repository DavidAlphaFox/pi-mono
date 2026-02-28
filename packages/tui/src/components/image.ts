/**
 * @file 图像显示组件
 *
 * 在终端中显示图像，支持 Kitty 和 iTerm2 图像协议。
 * 当终端不支持图像时显示文本回退描述。
 */

import {
	getCapabilities,
	getImageDimensions,
	type ImageDimensions,
	imageFallback,
	renderImage,
} from "../terminal-image.js";
import type { Component } from "../tui.js";

/** 图像组件主题 */
export interface ImageTheme {
	/** 不支持图像时的回退文本颜色函数 */
	fallbackColor: (str: string) => string;
}

/** 图像显示选项 */
export interface ImageOptions {
	/** 最大宽度（单元格数） */
	maxWidthCells?: number;
	/** 最大高度（单元格数） */
	maxHeightCells?: number;
	/** 文件名（用于回退文本显示） */
	filename?: string;
	/** Kitty 图像 ID。如果提供则复用此 ID（用于动画/更新） */
	imageId?: number;
}

/**
 * 图像显示组件。
 * 使用终端图像协议（Kitty/iTerm2）显示图像，
 * 不支持时显示文本回退信息。
 */
export class Image implements Component {
	/** Base64 编码的图像数据 */
	private base64Data: string;
	/** 图像 MIME 类型 */
	private mimeType: string;
	/** 图像像素尺寸 */
	private dimensions: ImageDimensions;
	/** 主题配置 */
	private theme: ImageTheme;
	/** 显示选项 */
	private options: ImageOptions;
	/** Kitty 图像 ID（用于图像替换和删除） */
	private imageId?: number;

	/** 渲染缓存 */
	private cachedLines?: string[];
	private cachedWidth?: number;

	constructor(
		base64Data: string,
		mimeType: string,
		theme: ImageTheme,
		options: ImageOptions = {},
		dimensions?: ImageDimensions,
	) {
		this.base64Data = base64Data;
		this.mimeType = mimeType;
		this.theme = theme;
		this.options = options;
		this.dimensions = dimensions || getImageDimensions(base64Data, mimeType) || { widthPx: 800, heightPx: 600 };
		this.imageId = options.imageId;
	}

	/** 获取此图像使用的 Kitty 图像 ID（如果有） */
	getImageId(): number | undefined {
		return this.imageId;
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const maxWidth = Math.min(width - 2, this.options.maxWidthCells ?? 60);

		const caps = getCapabilities();
		let lines: string[];

		if (caps.images) {
			const result = renderImage(this.base64Data, this.dimensions, {
				maxWidthCells: maxWidth,
				imageId: this.imageId,
			});

			if (result) {
				// Store the image ID for later cleanup
				if (result.imageId) {
					this.imageId = result.imageId;
				}

				// Return `rows` lines so TUI accounts for image height
				// First (rows-1) lines are empty (TUI clears them)
				// Last line: move cursor back up, then output image sequence
				lines = [];
				for (let i = 0; i < result.rows - 1; i++) {
					lines.push("");
				}
				// Move cursor up to first row, then output image
				const moveUp = result.rows > 1 ? `\x1b[${result.rows - 1}A` : "";
				lines.push(moveUp + result.sequence);
			} else {
				const fallback = imageFallback(this.mimeType, this.dimensions, this.options.filename);
				lines = [this.theme.fallbackColor(fallback)];
			}
		} else {
			const fallback = imageFallback(this.mimeType, this.dimensions, this.options.filename);
			lines = [this.theme.fallbackColor(fallback)];
		}

		this.cachedLines = lines;
		this.cachedWidth = width;

		return lines;
	}
}
