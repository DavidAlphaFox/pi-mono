/**
 * 启动性能分析计时模块
 *
 * 职责：
 * - 记录各启动阶段的耗时
 * - 通过 PI_TIMING=1 环境变量启用
 * - 输出各阶段耗时和总计到 stderr
 */

const ENABLED = process.env.PI_TIMING === "1";
const timings: Array<{ label: string; ms: number }> = [];
let lastTime = Date.now();

/** 记录一个计时点（标签 + 距上一次的毫秒数） */
export function time(label: string): void {
	if (!ENABLED) return;
	const now = Date.now();
	timings.push({ label, ms: now - lastTime });
	lastTime = now;
}

/** 打印所有计时结果到 stderr */
export function printTimings(): void {
	if (!ENABLED || timings.length === 0) return;
	console.error("\n--- Startup Timings ---");
	for (const t of timings) {
		console.error(`  ${t.label}: ${t.ms}ms`);
	}
	console.error(`  TOTAL: ${timings.reduce((a, b) => a + b.ms, 0)}ms`);
	console.error("------------------------\n");
}
