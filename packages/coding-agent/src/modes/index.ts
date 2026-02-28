/**
 * 编码代理的运行模式入口文件。
 *
 * 该文件作为桶导出（barrel export），统一导出三种运行模式：
 * - Interactive（交互式）：完整的 TUI 终端用户界面模式
 * - Print（打印）：单次运行模式，输出结果后退出
 * - RPC（远程过程调用）：无界面的 JSON 协议模式，用于程序化访问
 */

/** 交互式 TUI 模式及其配置选项 */
export { InteractiveMode, type InteractiveModeOptions } from "./interactive/interactive-mode.js";
/** 单次打印模式及其配置选项 */
export { type PrintModeOptions, runPrintMode } from "./print-mode.js";
/** RPC 客户端及其相关类型（用于外部程序调用） */
export { type ModelInfo, RpcClient, type RpcClientOptions, type RpcEventListener } from "./rpc/rpc-client.js";
/** RPC 模式运行入口 */
export { runRpcMode } from "./rpc/rpc-mode.js";
/** RPC 协议类型定义（命令、响应、会话状态） */
export type { RpcCommand, RpcResponse, RpcSessionState } from "./rpc/rpc-types.js";
