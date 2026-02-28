/**
 * 分支摘要生成（用于会话树导航）
 *
 * 当用户导航到会话树的不同位置时，本模块为即将离开的分支生成摘要，
 * 以确保上下文不会丢失。
 *
 * 主要功能：
 * 1. 收集需要摘要的条目：从旧位置回溯到与目标位置的共同祖先
 * 2. 带令牌预算的条目准备：从最新到最旧添加消息，优先保留最近的上下文
 * 3. 文件操作跟踪：从工具调用和已有的分支摘要中提取文件操作
 * 4. 使用 LLM 生成结构化分支摘要
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import { completeSimple } from "@mariozechner/pi-ai";
import {
	convertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../messages.js";
import type { ReadonlySessionManager, SessionEntry } from "../session-manager.js";
import { estimateTokens } from "./compaction.js";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversation,
} from "./utils.js";

// ============================================================================
// Types
// ============================================================================

/** 分支摘要生成的结果 */
export interface BranchSummaryResult {
	/** 生成的摘要文本 */
	summary?: string;
	/** 被读取的文件列表 */
	readFiles?: string[];
	/** 被修改的文件列表 */
	modifiedFiles?: string[];
	/** 是否被中止 */
	aborted?: boolean;
	/** 错误信息 */
	error?: string;
}

/** 存储在 BranchSummaryEntry.details 中的文件跟踪信息 */
export interface BranchSummaryDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

export type { FileOperations } from "./utils.js";

/** 分支准备数据，包含提取的消息、文件操作和令牌统计 */
export interface BranchPreparation {
	/** 用于摘要的消息，按时间顺序排列 */
	messages: AgentMessage[];
	/** 从工具调用中提取的文件操作 */
	fileOps: FileOperations;
	/** 消息的估算总令牌数 */
	totalTokens: number;
}

/** 收集条目的结果 */
export interface CollectEntriesResult {
	/** 需要摘要的条目，按时间顺序排列 */
	entries: SessionEntry[];
	/** 旧位置和新位置的共同祖先（如果有） */
	commonAncestorId: string | null;
}

/** 分支摘要生成选项 */
export interface GenerateBranchSummaryOptions {
	/** 用于摘要的模型 */
	model: Model<any>;
	/** 模型的 API 密钥 */
	apiKey: string;
	/** 用于取消操作的中止信号 */
	signal: AbortSignal;
	/** 可选的自定义摘要指令 */
	customInstructions?: string;
	/** 如果为 true，customInstructions 替换默认提示词而非追加 */
	replaceInstructions?: boolean;
	/** 为提示词和 LLM 响应预留的令牌数（默认 16384） */
	reserveTokens?: number;
}

// ============================================================================
// Entry Collection
// ============================================================================

/**
 * 收集从一个位置导航到另一个位置时需要摘要的条目。
 *
 * 从 oldLeafId 回溯到与 targetId 的共同祖先，沿途收集条目。
 * 不会在压缩边界处停止 - 压缩条目也会被包含，其摘要成为上下文。
 *
 * @param session - 会话管理器（只读访问）
 * @param oldLeafId - 当前位置（导航起点）
 * @param targetId - 目标位置（导航终点）
 * @returns 需要摘要的条目和共同祖先
 */
export function collectEntriesForBranchSummary(
	session: ReadonlySessionManager,
	oldLeafId: string | null,
	targetId: string,
): CollectEntriesResult {
	// If no old position, nothing to summarize
	if (!oldLeafId) {
		return { entries: [], commonAncestorId: null };
	}

	// Find common ancestor (deepest node that's on both paths)
	const oldPath = new Set(session.getBranch(oldLeafId).map((e) => e.id));
	const targetPath = session.getBranch(targetId);

	// targetPath is root-first, so iterate backwards to find deepest common ancestor
	let commonAncestorId: string | null = null;
	for (let i = targetPath.length - 1; i >= 0; i--) {
		if (oldPath.has(targetPath[i].id)) {
			commonAncestorId = targetPath[i].id;
			break;
		}
	}

	// Collect entries from old leaf back to common ancestor
	const entries: SessionEntry[] = [];
	let current: string | null = oldLeafId;

	while (current && current !== commonAncestorId) {
		const entry = session.getEntry(current);
		if (!entry) break;
		entries.push(entry);
		current = entry.parentId;
	}

	// Reverse to get chronological order
	entries.reverse();

	return { entries, commonAncestorId };
}

// ============================================================================
// Entry to Message Conversion
// ============================================================================

/**
 * 从会话条目中提取 AgentMessage。
 * 类似于 compaction.ts 中的 getMessageFromEntry，但也处理压缩条目。
 */
function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	switch (entry.type) {
		case "message":
			// Skip tool results - context is in assistant's tool call
			if (entry.message.role === "toolResult") return undefined;
			return entry.message;

		case "custom_message":
			return createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp);

		case "branch_summary":
			return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);

		case "compaction":
			return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);

		// These don't contribute to conversation content
		case "thinking_level_change":
		case "model_change":
		case "custom":
		case "label":
			return undefined;
	}
}

/**
 * 在令牌预算内准备摘要所需的条目。
 *
 * 从最新到最旧遍历条目，逐步添加消息直到达到令牌预算。
 * 这确保在分支过长时优先保留最近的上下文。
 *
 * 同时从以下来源收集文件操作：
 * - 助手消息中的工具调用
 * - 现有 branch_summary 条目的详情（用于累积跟踪）
 *
 * @param entries - 按时间顺序排列的条目
 * @param tokenBudget - 最大令牌数（0 表示无限制）
 */
export function prepareBranchEntries(entries: SessionEntry[], tokenBudget: number = 0): BranchPreparation {
	const messages: AgentMessage[] = [];
	const fileOps = createFileOps();
	let totalTokens = 0;

	// First pass: collect file ops from ALL entries (even if they don't fit in token budget)
	// This ensures we capture cumulative file tracking from nested branch summaries
	// Only extract from pi-generated summaries (fromHook !== true), not extension-generated ones
	for (const entry of entries) {
		if (entry.type === "branch_summary" && !entry.fromHook && entry.details) {
			const details = entry.details as BranchSummaryDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				// Modified files go into both edited and written for proper deduplication
				for (const f of details.modifiedFiles) {
					fileOps.edited.add(f);
				}
			}
		}
	}

	// Second pass: walk from newest to oldest, adding messages until token budget
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getMessageFromEntry(entry);
		if (!message) continue;

		// Extract file ops from assistant messages (tool calls)
		extractFileOpsFromMessage(message, fileOps);

		const tokens = estimateTokens(message);

		// Check budget before adding
		if (tokenBudget > 0 && totalTokens + tokens > tokenBudget) {
			// If this is a summary entry, try to fit it anyway as it's important context
			if (entry.type === "compaction" || entry.type === "branch_summary") {
				if (totalTokens < tokenBudget * 0.9) {
					messages.unshift(message);
					totalTokens += tokens;
				}
			}
			// Stop - we've hit the budget
			break;
		}

		messages.unshift(message);
		totalTokens += tokens;
	}

	return { messages, fileOps, totalTokens };
}

// ============================================================================
// Summary Generation
// ============================================================================

const BRANCH_SUMMARY_PREAMBLE = `The user explored a different conversation branch before returning here.
Summary of that exploration:

`;

const BRANCH_SUMMARY_PROMPT = `Create a structured summary of this conversation branch for context when returning later.

Use this EXACT format:

## Goal
[What was the user trying to accomplish in this branch?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Work that was started but not finished]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next to continue this work]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/**
 * 为离开的分支条目生成摘要。
 *
 * @param entries - 需要摘要的会话条目（按时间顺序排列）
 * @param options - 生成选项
 */
export async function generateBranchSummary(
	entries: SessionEntry[],
	options: GenerateBranchSummaryOptions,
): Promise<BranchSummaryResult> {
	const { model, apiKey, signal, customInstructions, replaceInstructions, reserveTokens = 16384 } = options;

	// Token budget = context window minus reserved space for prompt + response
	const contextWindow = model.contextWindow || 128000;
	const tokenBudget = contextWindow - reserveTokens;

	const { messages, fileOps } = prepareBranchEntries(entries, tokenBudget);

	if (messages.length === 0) {
		return { summary: "No content to summarize" };
	}

	// Transform to LLM-compatible messages, then serialize to text
	// Serialization prevents the model from treating it as a conversation to continue
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);

	// Build prompt
	let instructions: string;
	if (replaceInstructions && customInstructions) {
		instructions = customInstructions;
	} else if (customInstructions) {
		instructions = `${BRANCH_SUMMARY_PROMPT}\n\nAdditional focus: ${customInstructions}`;
	} else {
		instructions = BRANCH_SUMMARY_PROMPT;
	}
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${instructions}`;

	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	// Call LLM for summarization
	const response = await completeSimple(
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		{ apiKey, signal, maxTokens: 2048 },
	);

	// Check if aborted or errored
	if (response.stopReason === "aborted") {
		return { aborted: true };
	}
	if (response.stopReason === "error") {
		return { error: response.errorMessage || "Summarization failed" };
	}

	let summary = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");

	// Prepend preamble to provide context about the branch summary
	summary = BRANCH_SUMMARY_PREAMBLE + summary;

	// Compute file lists and append to summary
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	return {
		summary: summary || "No summary generated",
		readFiles,
		modifiedFiles,
	};
}
