/**
 * 扩展加载器 - 使用 jiti 加载 TypeScript 扩展模块
 *
 * 本文件负责扩展的发现、加载和初始化，主要功能包括：
 * 1. 使用 @mariozechner/jiti（支持 virtualModules 的 fork）加载 TypeScript 扩展
 * 2. 在 Bun 编译二进制中使用 virtualModules，在 Node.js 中使用 alias 解析依赖
 * 3. 创建 ExtensionRuntime（带占位的操作方法，由 Runner.bindCore() 后替换为真实实现）
 * 4. 创建 ExtensionAPI（注册方法写入扩展对象，操作方法委托给共享 runtime）
 * 5. 从标准位置发现扩展：项目本地（.pi/extensions/）、全局（agentDir/extensions/）、显式配置路径
 * 6. 支持 package.json 中的 "pi" 清单字段声明扩展入口
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "@mariozechner/jiti";
import * as _bundledPiAgentCore from "@mariozechner/pi-agent-core";
import * as _bundledPiAi from "@mariozechner/pi-ai";
import type { KeyId } from "@mariozechner/pi-tui";
import * as _bundledPiTui from "@mariozechner/pi-tui";
// Static imports of packages that extensions may use.
// These MUST be static so Bun bundles them into the compiled binary.
// The virtualModules option then makes them available to extensions.
import * as _bundledTypebox from "@sinclair/typebox";
import { getAgentDir, isBunBinary } from "../../config.js";
// NOTE: This import works because loader.ts exports are NOT re-exported from index.ts,
// avoiding a circular dependency. Extensions can import from @mariozechner/pi-coding-agent.
import * as _bundledPiCodingAgent from "../../index.js";
import { createEventBus, type EventBus } from "../event-bus.js";
import type { ExecOptions } from "../exec.js";
import { execCommand } from "../exec.js";
import type {
	Extension,
	ExtensionAPI,
	ExtensionFactory,
	ExtensionRuntime,
	LoadExtensionsResult,
	MessageRenderer,
	ProviderConfig,
	RegisteredCommand,
	ToolDefinition,
} from "./types.js";

/** 通过 virtualModules 对扩展可用的模块（用于编译的 Bun 二进制） */
const VIRTUAL_MODULES: Record<string, unknown> = {
	"@sinclair/typebox": _bundledTypebox,
	"@mariozechner/pi-agent-core": _bundledPiAgentCore,
	"@mariozechner/pi-tui": _bundledPiTui,
	"@mariozechner/pi-ai": _bundledPiAi,
	"@mariozechner/pi-coding-agent": _bundledPiCodingAgent,
};

const require = createRequire(import.meta.url);

/**
 * 获取 jiti 的别名配置（在 Node.js/开发模式下使用）。
 * 在 Bun 二进制模式下使用 virtualModules 替代。
 */
let _aliases: Record<string, string> | null = null;
function getAliases(): Record<string, string> {
	if (_aliases) return _aliases;

	const __dirname = path.dirname(fileURLToPath(import.meta.url));
	const packageIndex = path.resolve(__dirname, "../..", "index.js");

	const typeboxEntry = require.resolve("@sinclair/typebox");
	const typeboxRoot = typeboxEntry.replace(/[\\/]build[\\/]cjs[\\/]index\.js$/, "");

	_aliases = {
		"@mariozechner/pi-coding-agent": packageIndex,
		"@mariozechner/pi-agent-core": require.resolve("@mariozechner/pi-agent-core"),
		"@mariozechner/pi-tui": require.resolve("@mariozechner/pi-tui"),
		"@mariozechner/pi-ai": require.resolve("@mariozechner/pi-ai"),
		"@sinclair/typebox": typeboxRoot,
	};

	return _aliases;
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function normalizeUnicodeSpaces(str: string): string {
	return str.replace(UNICODE_SPACES, " ");
}

function expandPath(p: string): string {
	const normalized = normalizeUnicodeSpaces(p);
	if (normalized.startsWith("~/")) {
		return path.join(os.homedir(), normalized.slice(2));
	}
	if (normalized.startsWith("~")) {
		return path.join(os.homedir(), normalized.slice(1));
	}
	return normalized;
}

function resolvePath(extPath: string, cwd: string): string {
	const expanded = expandPath(extPath);
	if (path.isAbsolute(expanded)) {
		return expanded;
	}
	return path.resolve(cwd, expanded);
}

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

/**
 * 创建带抛异常占位方法的扩展运行时。
 * Runner.bindCore() 会将这些占位方法替换为真实实现。
 */
export function createExtensionRuntime(): ExtensionRuntime {
	const notInitialized = () => {
		throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
	};

	const runtime: ExtensionRuntime = {
		sendMessage: notInitialized,
		sendUserMessage: notInitialized,
		appendEntry: notInitialized,
		setSessionName: notInitialized,
		getSessionName: notInitialized,
		setLabel: notInitialized,
		getActiveTools: notInitialized,
		getAllTools: notInitialized,
		setActiveTools: notInitialized,
		getCommands: notInitialized,
		setModel: () => Promise.reject(new Error("Extension runtime not initialized")),
		getThinkingLevel: notInitialized,
		setThinkingLevel: notInitialized,
		flagValues: new Map(),
		pendingProviderRegistrations: [],
		// Pre-bind: queue registrations so bindCore() can flush them once the
		// model registry is available. bindCore() replaces both with direct calls.
		registerProvider: (name, config) => {
			runtime.pendingProviderRegistrations.push({ name, config });
		},
		unregisterProvider: (name) => {
			runtime.pendingProviderRegistrations = runtime.pendingProviderRegistrations.filter((r) => r.name !== name);
		},
	};

	return runtime;
}

/**
 * 为扩展创建 ExtensionAPI。
 * 注册方法将数据写入扩展对象，操作方法委托给共享的 runtime。
 */
function createExtensionAPI(
	extension: Extension,
	runtime: ExtensionRuntime,
	cwd: string,
	eventBus: EventBus,
): ExtensionAPI {
	const api = {
		// Registration methods - write to extension
		on(event: string, handler: HandlerFn): void {
			const list = extension.handlers.get(event) ?? [];
			list.push(handler);
			extension.handlers.set(event, list);
		},

		registerTool(tool: ToolDefinition): void {
			extension.tools.set(tool.name, {
				definition: tool,
				extensionPath: extension.path,
			});
		},

		registerCommand(name: string, options: Omit<RegisteredCommand, "name">): void {
			extension.commands.set(name, { name, ...options });
		},

		registerShortcut(
			shortcut: KeyId,
			options: {
				description?: string;
				handler: (ctx: import("./types.js").ExtensionContext) => Promise<void> | void;
			},
		): void {
			extension.shortcuts.set(shortcut, { shortcut, extensionPath: extension.path, ...options });
		},

		registerFlag(
			name: string,
			options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
		): void {
			extension.flags.set(name, { name, extensionPath: extension.path, ...options });
			if (options.default !== undefined && !runtime.flagValues.has(name)) {
				runtime.flagValues.set(name, options.default);
			}
		},

		registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void {
			extension.messageRenderers.set(customType, renderer as MessageRenderer);
		},

		// Flag access - checks extension registered it, reads from runtime
		getFlag(name: string): boolean | string | undefined {
			if (!extension.flags.has(name)) return undefined;
			return runtime.flagValues.get(name);
		},

		// Action methods - delegate to shared runtime
		sendMessage(message, options): void {
			runtime.sendMessage(message, options);
		},

		sendUserMessage(content, options): void {
			runtime.sendUserMessage(content, options);
		},

		appendEntry(customType: string, data?: unknown): void {
			runtime.appendEntry(customType, data);
		},

		setSessionName(name: string): void {
			runtime.setSessionName(name);
		},

		getSessionName(): string | undefined {
			return runtime.getSessionName();
		},

		setLabel(entryId: string, label: string | undefined): void {
			runtime.setLabel(entryId, label);
		},

		exec(command: string, args: string[], options?: ExecOptions) {
			return execCommand(command, args, options?.cwd ?? cwd, options);
		},

		getActiveTools(): string[] {
			return runtime.getActiveTools();
		},

		getAllTools() {
			return runtime.getAllTools();
		},

		setActiveTools(toolNames: string[]): void {
			runtime.setActiveTools(toolNames);
		},

		getCommands() {
			return runtime.getCommands();
		},

		setModel(model) {
			return runtime.setModel(model);
		},

		getThinkingLevel() {
			return runtime.getThinkingLevel();
		},

		setThinkingLevel(level) {
			runtime.setThinkingLevel(level);
		},

		registerProvider(name: string, config: ProviderConfig) {
			runtime.registerProvider(name, config);
		},

		unregisterProvider(name: string) {
			runtime.unregisterProvider(name);
		},

		events: eventBus,
	} as ExtensionAPI;

	return api;
}

/** 使用 jiti 加载扩展模块，返回工厂函数（如果有效） */
async function loadExtensionModule(extensionPath: string) {
	const jiti = createJiti(import.meta.url, {
		moduleCache: false,
		// In Bun binary: use virtualModules for bundled packages (no filesystem resolution)
		// Also disable tryNative so jiti handles ALL imports (not just the entry point)
		// In Node.js/dev: use aliases to resolve to node_modules paths
		...(isBunBinary ? { virtualModules: VIRTUAL_MODULES, tryNative: false } : { alias: getAliases() }),
	});

	const module = await jiti.import(extensionPath, { default: true });
	const factory = module as ExtensionFactory;
	return typeof factory !== "function" ? undefined : factory;
}

/**
 * 创建一个带空集合的 Extension 对象。
 */
function createExtension(extensionPath: string, resolvedPath: string): Extension {
	return {
		path: extensionPath,
		resolvedPath,
		handlers: new Map(),
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

/** 加载单个扩展：解析路径、加载模块、创建扩展对象并调用工厂函数 */
async function loadExtension(
	extensionPath: string,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
): Promise<{ extension: Extension | null; error: string | null }> {
	const resolvedPath = resolvePath(extensionPath, cwd);

	try {
		const factory = await loadExtensionModule(resolvedPath);
		if (!factory) {
			return { extension: null, error: `Extension does not export a valid factory function: ${extensionPath}` };
		}

		const extension = createExtension(extensionPath, resolvedPath);
		const api = createExtensionAPI(extension, runtime, cwd, eventBus);
		await factory(api);

		return { extension, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { extension: null, error: `Failed to load extension: ${message}` };
	}
}

/**
 * 从内联工厂函数创建扩展（用于编程式注册）。
 */
export async function loadExtensionFromFactory(
	factory: ExtensionFactory,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	extensionPath = "<inline>",
): Promise<Extension> {
	const extension = createExtension(extensionPath, extensionPath);
	const api = createExtensionAPI(extension, runtime, cwd, eventBus);
	await factory(api);
	return extension;
}

/**
 * 从路径列表加载扩展。
 */
export async function loadExtensions(paths: string[], cwd: string, eventBus?: EventBus): Promise<LoadExtensionsResult> {
	const extensions: Extension[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const resolvedEventBus = eventBus ?? createEventBus();
	const runtime = createExtensionRuntime();

	for (const extPath of paths) {
		const { extension, error } = await loadExtension(extPath, cwd, resolvedEventBus, runtime);

		if (error) {
			errors.push({ path: extPath, error });
			continue;
		}

		if (extension) {
			extensions.push(extension);
		}
	}

	return {
		extensions,
		errors,
		runtime,
	};
}

/** package.json 中 "pi" 字段的清单结构 */
interface PiManifest {
	extensions?: string[];
	themes?: string[];
	skills?: string[];
	prompts?: string[];
}

/** 读取 package.json 中的 "pi" 清单字段 */
function readPiManifest(packageJsonPath: string): PiManifest | null {
	try {
		const content = fs.readFileSync(packageJsonPath, "utf-8");
		const pkg = JSON.parse(content);
		if (pkg.pi && typeof pkg.pi === "object") {
			return pkg.pi as PiManifest;
		}
		return null;
	} catch {
		return null;
	}
}

/** 检查文件名是否为扩展文件（.ts 或 .js） */
function isExtensionFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

/**
 * 从目录中解析扩展入口点。
 *
 * 检查顺序：
 * 1. package.json 中有 "pi.extensions" 字段 -> 返回声明的路径
 * 2. 存在 index.ts 或 index.js -> 返回索引文件
 *
 * 未找到入口点时返回 null。
 */
function resolveExtensionEntries(dir: string): string[] | null {
	// Check for package.json with "pi" field first
	const packageJsonPath = path.join(dir, "package.json");
	if (fs.existsSync(packageJsonPath)) {
		const manifest = readPiManifest(packageJsonPath);
		if (manifest?.extensions?.length) {
			const entries: string[] = [];
			for (const extPath of manifest.extensions) {
				const resolvedExtPath = path.resolve(dir, extPath);
				if (fs.existsSync(resolvedExtPath)) {
					entries.push(resolvedExtPath);
				}
			}
			if (entries.length > 0) {
				return entries;
			}
		}
	}

	// Check for index.ts or index.js
	const indexTs = path.join(dir, "index.ts");
	const indexJs = path.join(dir, "index.js");
	if (fs.existsSync(indexTs)) {
		return [indexTs];
	}
	if (fs.existsSync(indexJs)) {
		return [indexJs];
	}

	return null;
}

/**
 * 在目录中发现扩展。
 *
 * 发现规则：
 * 1. 直接文件：extensions/*.ts 或 *.js -> 加载
 * 2. 带索引的子目录：extensions/子目录/index.ts 或 index.js -> 加载
 * 3. 带 package.json 的子目录：extensions/子目录/package.json 有 "pi" 字段 -> 加载其声明的内容
 *
 * 不递归超过一层。复杂的包必须使用 package.json 清单。
 */
function discoverExtensionsInDir(dir: string): string[] {
	if (!fs.existsSync(dir)) {
		return [];
	}

	const discovered: string[] = [];

	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			const entryPath = path.join(dir, entry.name);

			// 1. Direct files: *.ts or *.js
			if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
				discovered.push(entryPath);
				continue;
			}

			// 2 & 3. Subdirectories
			if (entry.isDirectory() || entry.isSymbolicLink()) {
				const entries = resolveExtensionEntries(entryPath);
				if (entries) {
					discovered.push(...entries);
				}
			}
		}
	} catch {
		return [];
	}

	return discovered;
}

/**
 * 从标准位置发现并加载扩展。
 * 搜索顺序：项目本地（cwd/.pi/extensions/）、全局（agentDir/extensions/）、显式配置路径。
 */
export async function discoverAndLoadExtensions(
	configuredPaths: string[],
	cwd: string,
	agentDir: string = getAgentDir(),
	eventBus?: EventBus,
): Promise<LoadExtensionsResult> {
	const allPaths: string[] = [];
	const seen = new Set<string>();

	const addPaths = (paths: string[]) => {
		for (const p of paths) {
			const resolved = path.resolve(p);
			if (!seen.has(resolved)) {
				seen.add(resolved);
				allPaths.push(p);
			}
		}
	};

	// 1. Project-local extensions: cwd/.pi/extensions/
	const localExtDir = path.join(cwd, ".pi", "extensions");
	addPaths(discoverExtensionsInDir(localExtDir));

	// 2. Global extensions: agentDir/extensions/
	const globalExtDir = path.join(agentDir, "extensions");
	addPaths(discoverExtensionsInDir(globalExtDir));

	// 3. Explicitly configured paths
	for (const p of configuredPaths) {
		const resolved = resolvePath(p, cwd);
		if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
			// Check for package.json with pi manifest or index.ts
			const entries = resolveExtensionEntries(resolved);
			if (entries) {
				addPaths(entries);
				continue;
			}
			// No explicit entries - discover individual files in directory
			addPaths(discoverExtensionsInDir(resolved));
			continue;
		}

		addPaths([resolved]);
	}

	return loadExtensions(allPaths, cwd, eventBus);
}
