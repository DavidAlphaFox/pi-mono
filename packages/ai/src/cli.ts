#!/usr/bin/env node
/**
 * @file CLI 工具入口
 *
 * 提供命令行界面用于 OAuth 登录和提供商管理：
 * - login：通过 OAuth 流程登录指定提供商（Anthropic、GitHub Copilot、Google 等）
 * - list：列出所有可用的 OAuth 提供商
 *
 * 凭据保存到本地 auth.json 文件中。
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { createInterface } from "readline";
import { getOAuthProvider, getOAuthProviders } from "./utils/oauth/index.js";
import type { OAuthCredentials, OAuthProviderId } from "./utils/oauth/types.js";

/** 凭据存储文件路径 */
const AUTH_FILE = "auth.json";
/** 所有已注册的 OAuth 提供商列表 */
const PROVIDERS = getOAuthProviders();

/** 封装 readline 的问答交互为 Promise */
function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
	return new Promise((resolve) => rl.question(question, resolve));
}

/** 从 auth.json 加载已保存的认证凭据 */
function loadAuth(): Record<string, { type: "oauth" } & OAuthCredentials> {
	if (!existsSync(AUTH_FILE)) return {};
	try {
		return JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
	} catch {
		return {};
	}
}

/** 将认证凭据保存到 auth.json */
function saveAuth(auth: Record<string, { type: "oauth" } & OAuthCredentials>): void {
	writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), "utf-8");
}

/** 执行指定提供商的 OAuth 登录流程，并将凭据保存到本地 */
async function login(providerId: OAuthProviderId): Promise<void> {
	const provider = getOAuthProvider(providerId);
	if (!provider) {
		console.error(`Unknown provider: ${providerId}`);
		process.exit(1);
	}

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const promptFn = (msg: string) => prompt(rl, `${msg} `);

	try {
		const credentials = await provider.login({
			onAuth: (info) => {
				console.log(`\nOpen this URL in your browser:\n${info.url}`);
				if (info.instructions) console.log(info.instructions);
				console.log();
			},
			onPrompt: async (p) => {
				return await promptFn(`${p.message}${p.placeholder ? ` (${p.placeholder})` : ""}:`);
			},
			onProgress: (msg) => console.log(msg),
		});

		const auth = loadAuth();
		auth[providerId] = { type: "oauth", ...credentials };
		saveAuth(auth);

		console.log(`\nCredentials saved to ${AUTH_FILE}`);
	} finally {
		rl.close();
	}
}

/** CLI 主函数，解析命令行参数并执行对应操作 */
async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const command = args[0];

	if (!command || command === "help" || command === "--help" || command === "-h") {
		const providerList = PROVIDERS.map((p) => `  ${p.id.padEnd(20)} ${p.name}`).join("\n");
		console.log(`Usage: npx @mariozechner/pi-ai <command> [provider]

Commands:
  login [provider]  Login to an OAuth provider
  list              List available providers

Providers:
${providerList}

Examples:
  npx @mariozechner/pi-ai login              # interactive provider selection
  npx @mariozechner/pi-ai login anthropic    # login to specific provider
  npx @mariozechner/pi-ai list               # list providers
`);
		return;
	}

	if (command === "list") {
		console.log("Available OAuth providers:\n");
		for (const p of PROVIDERS) {
			console.log(`  ${p.id.padEnd(20)} ${p.name}`);
		}
		return;
	}

	if (command === "login") {
		let provider = args[1] as OAuthProviderId | undefined;

		if (!provider) {
			const rl = createInterface({ input: process.stdin, output: process.stdout });
			console.log("Select a provider:\n");
			for (let i = 0; i < PROVIDERS.length; i++) {
				console.log(`  ${i + 1}. ${PROVIDERS[i].name}`);
			}
			console.log();

			const choice = await prompt(rl, `Enter number (1-${PROVIDERS.length}): `);
			rl.close();

			const index = parseInt(choice, 10) - 1;
			if (index < 0 || index >= PROVIDERS.length) {
				console.error("Invalid selection");
				process.exit(1);
			}
			provider = PROVIDERS[index].id;
		}

		if (!PROVIDERS.some((p) => p.id === provider)) {
			console.error(`Unknown provider: ${provider}`);
			console.error(`Use 'npx @mariozechner/pi-ai list' to see available providers`);
			process.exit(1);
		}

		console.log(`Logging in to ${provider}...`);
		await login(provider);
		return;
	}

	console.error(`Unknown command: ${command}`);
	console.error(`Use 'npx @mariozechner/pi-ai --help' for usage`);
	process.exit(1);
}

main().catch((err) => {
	console.error("Error:", err.message);
	process.exit(1);
});
