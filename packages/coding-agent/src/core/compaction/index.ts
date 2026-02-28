/**
 * 上下文压缩和摘要工具模块入口文件
 *
 * 本模块负责管理长会话中的上下文窗口，主要包含：
 * - compaction.ts: 上下文压缩核心逻辑（令牌估算、切割点检测、摘要生成）
 * - branch-summarization.ts: 分支切换时的摘要生成
 * - utils.ts: 共享工具函数（文件操作跟踪、消息序列化）
 */

export * from "./branch-summarization.js";
export * from "./compaction.js";
export * from "./utils.js";
