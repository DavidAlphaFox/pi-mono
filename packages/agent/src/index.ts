/**
 * @file 智能体核心包入口文件
 *
 * 本文件作为 @mariozechner/agent 包的公共 API 入口，
 * 统一导出智能体核心模块、循环函数、代理工具和类型定义。
 *
 * 模块组成：
 * - agent: 有状态的 Agent 类，封装智能体的完整生命周期管理
 * - agent-loop: 无状态的智能体循环函数，处理 LLM 调用与工具执行的迭代流程
 * - proxy: 代理流函数，用于通过中间服务器转发 LLM 请求
 * - types: 所有公共类型定义，包括消息、事件、配置等接口
 */

// 核心 Agent 类
export * from "./agent.js";
// 智能体循环函数
export * from "./agent-loop.js";
// 代理流工具
export * from "./proxy.js";
// 类型定义
export * from "./types.js";
