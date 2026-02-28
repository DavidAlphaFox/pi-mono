/**
 * @file 终端图像支持
 *
 * 本文件实现了终端图像渲染功能，支持以下协议：
 * - Kitty 图形协议（Kitty、Ghostty、WezTerm）
 * - iTerm2 内联图像协议（iTerm2）
 *
 * 主要功能：
 * - 检测终端能力（图像协议、真彩色、超链接支持）
 * - 图像编码和传输（base64 分块传输）
 * - 图像尺寸获取（PNG、JPEG、GIF、WebP）
 * - 图像行数计算（基于单元格像素尺寸）
 * - 图像 ID 管理（用于 Kitty 协议的图像替换和删除）
 */

/** 图像协议类型：Kitty、iTerm2 或不支持（null） */
export type ImageProtocol = "kitty" | "iterm2" | null;

/** 终端能力描述接口 */
export interface TerminalCapabilities {
	/** 支持的图像协议类型 */
	images: ImageProtocol;
	/** 是否支持真彩色（24位色） */
	trueColor: boolean;
	/** 是否支持超链接（OSC 8） */
	hyperlinks: boolean;
}

/** 终端单元格的像素尺寸 */
export interface CellDimensions {
	/** 单元格宽度（像素） */
	widthPx: number;
	/** 单元格高度（像素） */
	heightPx: number;
}

/** 图像的像素尺寸 */
export interface ImageDimensions {
	/** 图像宽度（像素） */
	widthPx: number;
	/** 图像高度（像素） */
	heightPx: number;
}

/** 图像渲染选项 */
export interface ImageRenderOptions {
	/** 最大宽度（单元格数） */
	maxWidthCells?: number;
	/** 最大高度（单元格数） */
	maxHeightCells?: number;
	/** 是否保持纵横比 */
	preserveAspectRatio?: boolean;
	/** Kitty 图像 ID。如果提供，则复用/替换具有此 ID 的现有图像。 */
	imageId?: number;
}

/** 缓存的终端能力检测结果 */
let cachedCapabilities: TerminalCapabilities | null = null;

// 默认单元格尺寸 - 当终端响应查询时由 TUI 更新
let cellDimensions: CellDimensions = { widthPx: 9, heightPx: 18 };

/** 获取当前终端单元格的像素尺寸 */
export function getCellDimensions(): CellDimensions {
	return cellDimensions;
}

/** 设置终端单元格的像素尺寸（通常由 TUI 在收到终端响应后调用） */
export function setCellDimensions(dims: CellDimensions): void {
	cellDimensions = dims;
}

/**
 * 检测当前终端的能力（图像协议、真彩色、超链接）。
 * 通过检查环境变量来判断终端类型。
 */
export function detectCapabilities(): TerminalCapabilities {
	const termProgram = process.env.TERM_PROGRAM?.toLowerCase() || "";
	const term = process.env.TERM?.toLowerCase() || "";
	const colorTerm = process.env.COLORTERM?.toLowerCase() || "";

	if (process.env.KITTY_WINDOW_ID || termProgram === "kitty") {
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	if (termProgram === "ghostty" || term.includes("ghostty") || process.env.GHOSTTY_RESOURCES_DIR) {
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	if (process.env.WEZTERM_PANE || termProgram === "wezterm") {
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	if (process.env.ITERM_SESSION_ID || termProgram === "iterm.app") {
		return { images: "iterm2", trueColor: true, hyperlinks: true };
	}

	if (termProgram === "vscode") {
		return { images: null, trueColor: true, hyperlinks: true };
	}

	if (termProgram === "alacritty") {
		return { images: null, trueColor: true, hyperlinks: true };
	}

	const trueColor = colorTerm === "truecolor" || colorTerm === "24bit";
	return { images: null, trueColor, hyperlinks: true };
}

/** 获取缓存的终端能力（首次调用时自动检测） */
export function getCapabilities(): TerminalCapabilities {
	if (!cachedCapabilities) {
		cachedCapabilities = detectCapabilities();
	}
	return cachedCapabilities;
}

/** 重置终端能力缓存（用于测试或终端切换） */
export function resetCapabilitiesCache(): void {
	cachedCapabilities = null;
}

/** Kitty 图形协议前缀 */
const KITTY_PREFIX = "\x1b_G";
/** iTerm2 内联图像协议前缀 */
const ITERM2_PREFIX = "\x1b]1337;File=";

/** 检查一行是否包含图像数据（Kitty 或 iTerm2 协议） */
export function isImageLine(line: string): boolean {
	// Fast path: sequence at line start (single-row images)
	if (line.startsWith(KITTY_PREFIX) || line.startsWith(ITERM2_PREFIX)) {
		return true;
	}
	// Slow path: sequence elsewhere (multi-row images have cursor-up prefix)
	return line.includes(KITTY_PREFIX) || line.includes(ITERM2_PREFIX);
}

/**
 * 为 Kitty 图形协议生成随机图像 ID。
 * 使用随机 ID 以避免不同模块实例之间的冲突
 * （例如主应用与扩展之间）。
 */
export function allocateImageId(): number {
	// Use random ID in range [1, 0xffffffff] to avoid collisions
	return Math.floor(Math.random() * 0xfffffffe) + 1;
}

/**
 * 将 base64 图像数据编码为 Kitty 图形协议序列。
 * 大数据会自动分块传输（每块 4096 字节）。
 */
export function encodeKitty(
	base64Data: string,
	options: {
		columns?: number;
		rows?: number;
		imageId?: number;
	} = {},
): string {
	const CHUNK_SIZE = 4096;

	const params: string[] = ["a=T", "f=100", "q=2"];

	if (options.columns) params.push(`c=${options.columns}`);
	if (options.rows) params.push(`r=${options.rows}`);
	if (options.imageId) params.push(`i=${options.imageId}`);

	if (base64Data.length <= CHUNK_SIZE) {
		return `\x1b_G${params.join(",")};${base64Data}\x1b\\`;
	}

	const chunks: string[] = [];
	let offset = 0;
	let isFirst = true;

	while (offset < base64Data.length) {
		const chunk = base64Data.slice(offset, offset + CHUNK_SIZE);
		const isLast = offset + CHUNK_SIZE >= base64Data.length;

		if (isFirst) {
			chunks.push(`\x1b_G${params.join(",")},m=1;${chunk}\x1b\\`);
			isFirst = false;
		} else if (isLast) {
			chunks.push(`\x1b_Gm=0;${chunk}\x1b\\`);
		} else {
			chunks.push(`\x1b_Gm=1;${chunk}\x1b\\`);
		}

		offset += CHUNK_SIZE;
	}

	return chunks.join("");
}

/**
 * 通过 ID 删除 Kitty 图形图像。
 * 使用大写 'I' 同时释放图像数据。
 */
export function deleteKittyImage(imageId: number): string {
	return `\x1b_Ga=d,d=I,i=${imageId}\x1b\\`;
}

/**
 * 删除所有可见的 Kitty 图形图像。
 * 使用大写 'A' 同时释放图像数据。
 */
export function deleteAllKittyImages(): string {
	return `\x1b_Ga=d,d=A\x1b\\`;
}

/** 将 base64 图像数据编码为 iTerm2 内联图像协议序列 */
export function encodeITerm2(
	base64Data: string,
	options: {
		width?: number | string;
		height?: number | string;
		name?: string;
		preserveAspectRatio?: boolean;
		inline?: boolean;
	} = {},
): string {
	const params: string[] = [`inline=${options.inline !== false ? 1 : 0}`];

	if (options.width !== undefined) params.push(`width=${options.width}`);
	if (options.height !== undefined) params.push(`height=${options.height}`);
	if (options.name) {
		const nameBase64 = Buffer.from(options.name).toString("base64");
		params.push(`name=${nameBase64}`);
	}
	if (options.preserveAspectRatio === false) {
		params.push("preserveAspectRatio=0");
	}

	return `\x1b]1337;File=${params.join(";")}:${base64Data}\x07`;
}

/** 计算图像在给定宽度下需要占用的终端行数（保持纵横比） */
export function calculateImageRows(
	imageDimensions: ImageDimensions,
	targetWidthCells: number,
	cellDimensions: CellDimensions = { widthPx: 9, heightPx: 18 },
): number {
	const targetWidthPx = targetWidthCells * cellDimensions.widthPx;
	const scale = targetWidthPx / imageDimensions.widthPx;
	const scaledHeightPx = imageDimensions.heightPx * scale;
	const rows = Math.ceil(scaledHeightPx / cellDimensions.heightPx);
	return Math.max(1, rows);
}

/** 从 base64 编码的 PNG 数据中提取图像尺寸 */
export function getPngDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 24) {
			return null;
		}

		if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
			return null;
		}

		const width = buffer.readUInt32BE(16);
		const height = buffer.readUInt32BE(20);

		return { widthPx: width, heightPx: height };
	} catch {
		return null;
	}
}

/** 从 base64 编码的 JPEG 数据中提取图像尺寸（扫描 SOF 标记） */
export function getJpegDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 2) {
			return null;
		}

		if (buffer[0] !== 0xff || buffer[1] !== 0xd8) {
			return null;
		}

		let offset = 2;
		while (offset < buffer.length - 9) {
			if (buffer[offset] !== 0xff) {
				offset++;
				continue;
			}

			const marker = buffer[offset + 1];

			if (marker >= 0xc0 && marker <= 0xc2) {
				const height = buffer.readUInt16BE(offset + 5);
				const width = buffer.readUInt16BE(offset + 7);
				return { widthPx: width, heightPx: height };
			}

			if (offset + 3 >= buffer.length) {
				return null;
			}
			const length = buffer.readUInt16BE(offset + 2);
			if (length < 2) {
				return null;
			}
			offset += 2 + length;
		}

		return null;
	} catch {
		return null;
	}
}

/** 从 base64 编码的 GIF 数据中提取图像尺寸 */
export function getGifDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 10) {
			return null;
		}

		const sig = buffer.slice(0, 6).toString("ascii");
		if (sig !== "GIF87a" && sig !== "GIF89a") {
			return null;
		}

		const width = buffer.readUInt16LE(6);
		const height = buffer.readUInt16LE(8);

		return { widthPx: width, heightPx: height };
	} catch {
		return null;
	}
}

/** 从 base64 编码的 WebP 数据中提取图像尺寸（支持 VP8、VP8L、VP8X 格式） */
export function getWebpDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 30) {
			return null;
		}

		const riff = buffer.slice(0, 4).toString("ascii");
		const webp = buffer.slice(8, 12).toString("ascii");
		if (riff !== "RIFF" || webp !== "WEBP") {
			return null;
		}

		const chunk = buffer.slice(12, 16).toString("ascii");
		if (chunk === "VP8 ") {
			if (buffer.length < 30) return null;
			const width = buffer.readUInt16LE(26) & 0x3fff;
			const height = buffer.readUInt16LE(28) & 0x3fff;
			return { widthPx: width, heightPx: height };
		} else if (chunk === "VP8L") {
			if (buffer.length < 25) return null;
			const bits = buffer.readUInt32LE(21);
			const width = (bits & 0x3fff) + 1;
			const height = ((bits >> 14) & 0x3fff) + 1;
			return { widthPx: width, heightPx: height };
		} else if (chunk === "VP8X") {
			if (buffer.length < 30) return null;
			const width = (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1;
			const height = (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1;
			return { widthPx: width, heightPx: height };
		}

		return null;
	} catch {
		return null;
	}
}

/** 根据 MIME 类型自动选择合适的方法获取图像尺寸 */
export function getImageDimensions(base64Data: string, mimeType: string): ImageDimensions | null {
	if (mimeType === "image/png") {
		return getPngDimensions(base64Data);
	}
	if (mimeType === "image/jpeg") {
		return getJpegDimensions(base64Data);
	}
	if (mimeType === "image/gif") {
		return getGifDimensions(base64Data);
	}
	if (mimeType === "image/webp") {
		return getWebpDimensions(base64Data);
	}
	return null;
}

/**
 * 使用当前终端的图像协议渲染图像。
 * 返回转义序列字符串和占用的行数，如果终端不支持图像则返回 null。
 */
export function renderImage(
	base64Data: string,
	imageDimensions: ImageDimensions,
	options: ImageRenderOptions = {},
): { sequence: string; rows: number; imageId?: number } | null {
	const caps = getCapabilities();

	if (!caps.images) {
		return null;
	}

	const maxWidth = options.maxWidthCells ?? 80;
	const rows = calculateImageRows(imageDimensions, maxWidth, getCellDimensions());

	if (caps.images === "kitty") {
		// Only use imageId if explicitly provided - static images don't need IDs
		const sequence = encodeKitty(base64Data, { columns: maxWidth, rows, imageId: options.imageId });
		return { sequence, rows, imageId: options.imageId };
	}

	if (caps.images === "iterm2") {
		const sequence = encodeITerm2(base64Data, {
			width: maxWidth,
			height: "auto",
			preserveAspectRatio: options.preserveAspectRatio ?? true,
		});
		return { sequence, rows };
	}

	return null;
}

/** 当终端不支持图像时生成文本回退描述 */
export function imageFallback(mimeType: string, dimensions?: ImageDimensions, filename?: string): string {
	const parts: string[] = [];
	if (filename) parts.push(filename);
	parts.push(`[${mimeType}]`);
	if (dimensions) parts.push(`${dimensions.widthPx}x${dimensions.heightPx}`);
	return `[Image: ${parts.join(" ")}]`;
}
