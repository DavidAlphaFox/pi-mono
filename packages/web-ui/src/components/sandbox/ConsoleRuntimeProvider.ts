/**
 * @file ConsoleRuntimeProvider.ts
 * @description 控制台运行时提供者。
 * 必需的提供者，应始终首先包含。
 * 捕获沙箱中的 console.log/warn/error/info 输出，
 * 处理错误和执行生命周期管理，收集控制台输出供调用者检索。
 */

import type { SandboxRuntimeProvider } from "./SandboxRuntimeProvider.js";

/** 控制台日志条目接口 */
export interface ConsoleLog {
	type: "log" | "warn" | "error" | "info";
	text: string;
	args?: unknown[];
}

/**
 * 控制台运行时提供者。
 * 覆写沙箱中的 console 方法以捕获所有输出，
 * 管理代码执行的完成信号和错误收集。
 */
export class ConsoleRuntimeProvider implements SandboxRuntimeProvider {
	private logs: ConsoleLog[] = [];
	private completionError: { message: string; stack: string } | null = null;
	private completed = false;

	getData(): Record<string, any> {
		// No data needed
		return {};
	}

	getDescription(): string {
		return "";
	}

	getRuntime(): (sandboxId: string) => void {
		return (_sandboxId: string) => {
			// Store truly original console methods on first wrap only
			// This prevents accumulation of wrapper functions across multiple executions
			if (!(window as any).__originalConsole) {
				(window as any).__originalConsole = {
					log: console.log.bind(console),
					error: console.error.bind(console),
					warn: console.warn.bind(console),
					info: console.info.bind(console),
				};
			}

			// Always use the truly original console, not the current (possibly wrapped) one
			const originalConsole = (window as any).__originalConsole;

			// Track pending send promises to wait for them in onCompleted
			const pendingSends: Promise<any>[] = [];

			["log", "error", "warn", "info"].forEach((method) => {
				(console as any)[method] = (...args: any[]) => {
					const text = args
						.map((arg) => {
							try {
								return typeof arg === "object" ? JSON.stringify(arg) : String(arg);
							} catch {
								return String(arg);
							}
						})
						.join(" ");

					// Always log locally too (using truly original console)
					(originalConsole as any)[method].apply(console, args);

					// Send immediately and track the promise (only in extension context)
					if ((window as any).sendRuntimeMessage) {
						const sendPromise = (window as any)
							.sendRuntimeMessage({
								type: "console",
								method,
								text,
								args,
							})
							.catch(() => {});
						pendingSends.push(sendPromise);
					}
				};
			});

			// Register completion callback to wait for all pending sends
			if ((window as any).onCompleted) {
				(window as any).onCompleted(async (_success: boolean) => {
					// Wait for all pending console sends to complete
					if (pendingSends.length > 0) {
						await Promise.all(pendingSends);
					}
				});
			}

			// Track errors for HTML artifacts
			let lastError: { message: string; stack: string } | null = null;

			// Error handlers - track errors but don't log them
			// (they'll be shown via execution-error message)
			window.addEventListener("error", (e) => {
				const text = `${e.error?.stack || e.message || String(e)} at line ${e.lineno || "?"}:${e.colno || "?"}`;

				lastError = {
					message: e.error?.message || e.message || String(e),
					stack: e.error?.stack || text,
				};
			});

			window.addEventListener("unhandledrejection", (e) => {
				const text = `Unhandled promise rejection: ${e.reason?.message || e.reason || "Unknown error"}`;

				lastError = {
					message: e.reason?.message || String(e.reason) || "Unhandled promise rejection",
					stack: e.reason?.stack || text,
				};
			});

			// Expose complete() method for user code to call
			let completionSent = false;
			(window as any).complete = async (error?: { message: string; stack: string }, returnValue?: any) => {
				if (completionSent) return;
				completionSent = true;

				const finalError = error || lastError;

				if ((window as any).sendRuntimeMessage) {
					if (finalError) {
						await (window as any).sendRuntimeMessage({
							type: "execution-error",
							error: finalError,
						});
					} else {
						await (window as any).sendRuntimeMessage({
							type: "execution-complete",
							returnValue,
						});
					}
				}
			};
		};
	}

	async handleMessage(message: any, respond: (response: any) => void): Promise<void> {
		if (message.type === "console") {
			// Collect console output
			this.logs.push({
				type:
					message.method === "error"
						? "error"
						: message.method === "warn"
							? "warn"
							: message.method === "info"
								? "info"
								: "log",
				text: message.text,
				args: message.args,
			});
			// Acknowledge receipt
			respond({ success: true });
		}
	}

	/**
	 * Get collected console logs
	 */
	getLogs(): ConsoleLog[] {
		return this.logs;
	}

	/**
	 * Get completion status
	 */
	isCompleted(): boolean {
		return this.completed;
	}

	/**
	 * Get completion error if any
	 */
	getCompletionError(): { message: string; stack: string } | null {
		return this.completionError;
	}

	/**
	 * Reset state for reuse
	 */
	reset(): void {
		this.logs = [];
		this.completionError = null;
		this.completed = false;
	}
}
