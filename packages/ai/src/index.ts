/**
 * @file AI 统一抽象层包的入口文件
 *
 * 本文件是整个 AI 包的主导出入口，负责重新导出所有公共 API，包括：
 * - 类型系统（TypeBox 类型和自定义类型）
 * - API 注册表（提供商注册和查找）
 * - 模型注册表（模型定义和成本计算）
 * - 各提供商的流式处理函数（Anthropic、OpenAI、Google、AWS Bedrock 等）
 * - 工具函数（事件流、JSON 解析、OAuth 认证等）
 */

export type { Static, TSchema } from "@sinclair/typebox";
export { Type } from "@sinclair/typebox";

export * from "./api-registry.js";
export * from "./env-api-keys.js";
export * from "./models.js";
export * from "./providers/anthropic.js";
export * from "./providers/azure-openai-responses.js";
export * from "./providers/google.js";
export * from "./providers/google-gemini-cli.js";
export * from "./providers/google-vertex.js";
export * from "./providers/openai-completions.js";
export * from "./providers/openai-responses.js";
export * from "./providers/register-builtins.js";
export * from "./stream.js";
export * from "./types.js";
export * from "./utils/event-stream.js";
export * from "./utils/json-parse.js";
export * from "./utils/oauth/index.js";
export * from "./utils/overflow.js";
export * from "./utils/typebox-helpers.js";
export * from "./utils/validation.js";
