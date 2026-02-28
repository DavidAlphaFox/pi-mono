/**
 * 页脚数据提供器模块
 *
 * 职责：
 * - 提供 git 分支名（支持 worktree，通过文件监视自动更新）
 * - 管理扩展状态文本（通过 ctx.ui.setStatus() 设置）
 * - 跟踪可用提供商数量
 * - 提供只读视图给扩展使用
 */

import { existsSync, type FSWatcher, readFileSync, statSync, watch } from "fs";
import { dirname, join, resolve } from "path";

/**
 * 从 cwd 向上查找 git HEAD 文件路径
 * 同时处理常规 git 仓库（.git 是目录）和 worktree（.git 是文件）
 */
function findGitHeadPath(): string | null {
	let dir = process.cwd();
	while (true) {
		const gitPath = join(dir, ".git");
		if (existsSync(gitPath)) {
			try {
				const stat = statSync(gitPath);
				if (stat.isFile()) {
					const content = readFileSync(gitPath, "utf8").trim();
					if (content.startsWith("gitdir: ")) {
						const gitDir = content.slice(8);
						const headPath = resolve(dir, gitDir, "HEAD");
						if (existsSync(headPath)) return headPath;
					}
				} else if (stat.isDirectory()) {
					const headPath = join(gitPath, "HEAD");
					if (existsSync(headPath)) return headPath;
				}
			} catch {
				return null;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * 页脚数据提供器 - 提供 git 分支和扩展状态等扩展无法直接访问的数据
 * token 统计和模型信息可通过 ctx.sessionManager 和 ctx.model 获取
 */
export class FooterDataProvider {
	private extensionStatuses = new Map<string, string>();
	private cachedBranch: string | null | undefined = undefined;
	private gitWatcher: FSWatcher | null = null;
	private branchChangeCallbacks = new Set<() => void>();
	private availableProviderCount = 0;

	constructor() {
		this.setupGitWatcher();
	}

	/** Current git branch, null if not in repo, "detached" if detached HEAD */
	getGitBranch(): string | null {
		if (this.cachedBranch !== undefined) return this.cachedBranch;

		try {
			const gitHeadPath = findGitHeadPath();
			if (!gitHeadPath) {
				this.cachedBranch = null;
				return null;
			}
			const content = readFileSync(gitHeadPath, "utf8").trim();
			this.cachedBranch = content.startsWith("ref: refs/heads/") ? content.slice(16) : "detached";
		} catch {
			this.cachedBranch = null;
		}
		return this.cachedBranch;
	}

	/** Extension status texts set via ctx.ui.setStatus() */
	getExtensionStatuses(): ReadonlyMap<string, string> {
		return this.extensionStatuses;
	}

	/** Subscribe to git branch changes. Returns unsubscribe function. */
	onBranchChange(callback: () => void): () => void {
		this.branchChangeCallbacks.add(callback);
		return () => this.branchChangeCallbacks.delete(callback);
	}

	/** Internal: set extension status */
	setExtensionStatus(key: string, text: string | undefined): void {
		if (text === undefined) {
			this.extensionStatuses.delete(key);
		} else {
			this.extensionStatuses.set(key, text);
		}
	}

	/** Internal: clear extension statuses */
	clearExtensionStatuses(): void {
		this.extensionStatuses.clear();
	}

	/** Number of unique providers with available models (for footer display) */
	getAvailableProviderCount(): number {
		return this.availableProviderCount;
	}

	/** Internal: update available provider count */
	setAvailableProviderCount(count: number): void {
		this.availableProviderCount = count;
	}

	/** Internal: cleanup */
	dispose(): void {
		if (this.gitWatcher) {
			this.gitWatcher.close();
			this.gitWatcher = null;
		}
		this.branchChangeCallbacks.clear();
	}

	private setupGitWatcher(): void {
		if (this.gitWatcher) {
			this.gitWatcher.close();
			this.gitWatcher = null;
		}

		const gitHeadPath = findGitHeadPath();
		if (!gitHeadPath) return;

		// Watch the directory containing HEAD, not HEAD itself.
		// Git uses atomic writes (write temp, rename over HEAD), which changes the inode.
		// fs.watch on a file stops working after the inode changes.
		const gitDir = dirname(gitHeadPath);

		try {
			this.gitWatcher = watch(gitDir, (_eventType, filename) => {
				if (filename === "HEAD") {
					this.cachedBranch = undefined;
					for (const cb of this.branchChangeCallbacks) cb();
				}
			});
		} catch {
			// Silently fail if we can't watch
		}
	}
}

/** 扩展使用的只读视图 - 排除 setExtensionStatus、setAvailableProviderCount 和 dispose */
export type ReadonlyFooterDataProvider = Pick<
	FooterDataProvider,
	"getGitBranch" | "getExtensionStatuses" | "getAvailableProviderCount" | "onBranchChange"
>;
