#!/usr/bin/env node
/**
 * CLI 入口文件 - 编码智能体的命令行启动点
 *
 * 职责：
 * - 设置进程标题为 "pi"
 * - 解析命令行参数并传递给 main() 函数
 * - 使用 AgentSession 和运行模式模块进行初始化
 *
 * 测试方式：npx tsx src/cli-new.ts [args...]
 */
process.title = "pi";

import { main } from "./main.js";

// 去掉 node 和脚本路径，只传递用户提供的参数
main(process.argv.slice(2));
