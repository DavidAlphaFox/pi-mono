/**
 * ANSI 转义码到 HTML 的转换器
 *
 * 将终端 ANSI 颜色/样式转义码转换为带内联样式的 HTML。
 * 支持的功能：
 * - 标准前景色（30-37）和亮色变体（90-97）
 * - 标准背景色（40-47）和亮色变体（100-107）
 * - 256 色调色板（38;5;N 和 48;5;N）
 * - RGB 真彩色（38;2;R;G;B 和 48;2;R;G;B）
 * - 文本样式：粗体（1）、暗淡（2）、斜体（3）、下划线（4）
 * - 重置（0）
 */

// 标准 ANSI 颜色调色板（0-15）
const ANSI_COLORS = [
	"#000000", // 0: black
	"#800000", // 1: red
	"#008000", // 2: green
	"#808000", // 3: yellow
	"#000080", // 4: blue
	"#800080", // 5: magenta
	"#008080", // 6: cyan
	"#c0c0c0", // 7: white
	"#808080", // 8: bright black
	"#ff0000", // 9: bright red
	"#00ff00", // 10: bright green
	"#ffff00", // 11: bright yellow
	"#0000ff", // 12: bright blue
	"#ff00ff", // 13: bright magenta
	"#00ffff", // 14: bright cyan
	"#ffffff", // 15: bright white
];

/**
 * 将 256 色索引转换为十六进制颜色值。
 */
function color256ToHex(index: number): string {
	// Standard colors (0-15)
	if (index < 16) {
		return ANSI_COLORS[index];
	}

	// Color cube (16-231): 6x6x6 = 216 colors
	if (index < 232) {
		const cubeIndex = index - 16;
		const r = Math.floor(cubeIndex / 36);
		const g = Math.floor((cubeIndex % 36) / 6);
		const b = cubeIndex % 6;
		const toComponent = (n: number) => (n === 0 ? 0 : 55 + n * 40);
		const toHex = (n: number) => toComponent(n).toString(16).padStart(2, "0");
		return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
	}

	// Grayscale (232-255): 24 shades
	const gray = 8 + (index - 232) * 10;
	const grayHex = gray.toString(16).padStart(2, "0");
	return `#${grayHex}${grayHex}${grayHex}`;
}

/**
 * 转义 HTML 特殊字符。
 */
function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

/** 文本样式状态 */
interface TextStyle {
	fg: string | null;
	bg: string | null;
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
}

/** 创建空的文本样式 */
function createEmptyStyle(): TextStyle {
	return {
		fg: null,
		bg: null,
		bold: false,
		dim: false,
		italic: false,
		underline: false,
	};
}

/** 将文本样式转换为内联 CSS 字符串 */
function styleToInlineCSS(style: TextStyle): string {
	const parts: string[] = [];
	if (style.fg) parts.push(`color:${style.fg}`);
	if (style.bg) parts.push(`background-color:${style.bg}`);
	if (style.bold) parts.push("font-weight:bold");
	if (style.dim) parts.push("opacity:0.6");
	if (style.italic) parts.push("font-style:italic");
	if (style.underline) parts.push("text-decoration:underline");
	return parts.join(";");
}

/** 检查文本样式是否有任何活跃的样式属性 */
function hasStyle(style: TextStyle): boolean {
	return style.fg !== null || style.bg !== null || style.bold || style.dim || style.italic || style.underline;
}

/**
 * 解析 ANSI SGR（选择图形表现）代码并更新样式状态。
 */
function applySgrCode(params: number[], style: TextStyle): void {
	let i = 0;
	while (i < params.length) {
		const code = params[i];

		if (code === 0) {
			// Reset all
			style.fg = null;
			style.bg = null;
			style.bold = false;
			style.dim = false;
			style.italic = false;
			style.underline = false;
		} else if (code === 1) {
			style.bold = true;
		} else if (code === 2) {
			style.dim = true;
		} else if (code === 3) {
			style.italic = true;
		} else if (code === 4) {
			style.underline = true;
		} else if (code === 22) {
			// Reset bold/dim
			style.bold = false;
			style.dim = false;
		} else if (code === 23) {
			style.italic = false;
		} else if (code === 24) {
			style.underline = false;
		} else if (code >= 30 && code <= 37) {
			// Standard foreground colors
			style.fg = ANSI_COLORS[code - 30];
		} else if (code === 38) {
			// Extended foreground color
			if (params[i + 1] === 5 && params.length > i + 2) {
				// 256-color: 38;5;N
				style.fg = color256ToHex(params[i + 2]);
				i += 2;
			} else if (params[i + 1] === 2 && params.length > i + 4) {
				// RGB: 38;2;R;G;B
				const r = params[i + 2];
				const g = params[i + 3];
				const b = params[i + 4];
				style.fg = `rgb(${r},${g},${b})`;
				i += 4;
			}
		} else if (code === 39) {
			// Default foreground
			style.fg = null;
		} else if (code >= 40 && code <= 47) {
			// Standard background colors
			style.bg = ANSI_COLORS[code - 40];
		} else if (code === 48) {
			// Extended background color
			if (params[i + 1] === 5 && params.length > i + 2) {
				// 256-color: 48;5;N
				style.bg = color256ToHex(params[i + 2]);
				i += 2;
			} else if (params[i + 1] === 2 && params.length > i + 4) {
				// RGB: 48;2;R;G;B
				const r = params[i + 2];
				const g = params[i + 3];
				const b = params[i + 4];
				style.bg = `rgb(${r},${g},${b})`;
				i += 4;
			}
		} else if (code === 49) {
			// Default background
			style.bg = null;
		} else if (code >= 90 && code <= 97) {
			// Bright foreground colors
			style.fg = ANSI_COLORS[code - 90 + 8];
		} else if (code >= 100 && code <= 107) {
			// Bright background colors
			style.bg = ANSI_COLORS[code - 100 + 8];
		}
		// Ignore unrecognized codes

		i++;
	}
}

// 匹配 ANSI 转义序列：ESC[ 后跟参数，以 'm' 结尾
const ANSI_REGEX = /\x1b\[([\d;]*)m/g;

/**
 * 将包含 ANSI 转义码的文本转换为带内联样式的 HTML。
 */
export function ansiToHtml(text: string): string {
	const style = createEmptyStyle();
	let result = "";
	let lastIndex = 0;
	let inSpan = false;

	// Reset regex state
	ANSI_REGEX.lastIndex = 0;

	let match = ANSI_REGEX.exec(text);
	while (match !== null) {
		// Add text before this escape sequence
		const beforeText = text.slice(lastIndex, match.index);
		if (beforeText) {
			result += escapeHtml(beforeText);
		}

		// Parse SGR parameters
		const paramStr = match[1];
		const params = paramStr ? paramStr.split(";").map((p) => parseInt(p, 10) || 0) : [0];

		// Close existing span if we have one
		if (inSpan) {
			result += "</span>";
			inSpan = false;
		}

		// Apply the codes
		applySgrCode(params, style);

		// Open new span if we have any styling
		if (hasStyle(style)) {
			result += `<span style="${styleToInlineCSS(style)}">`;
			inSpan = true;
		}

		lastIndex = match.index + match[0].length;
		match = ANSI_REGEX.exec(text);
	}

	// Add remaining text
	const remainingText = text.slice(lastIndex);
	if (remainingText) {
		result += escapeHtml(remainingText);
	}

	// Close any open span
	if (inSpan) {
		result += "</span>";
	}

	return result;
}

/**
 * 将 ANSI 转义文本的行数组转换为 HTML。
 * 每行被包装在一个 div 元素中。
 */
export function ansiLinesToHtml(lines: string[]): string {
	return lines.map((line) => `<div class="ansi-line">${ansiToHtml(line) || "&nbsp;"}</div>`).join("\n");
}
