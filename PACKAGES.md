# Pi Mono 项目概览

Pi Mono 是一个模块化的 AI/LLM 工具链仓库，包含 7 个核心包，为开发者提供从底层 LLM API 调用到终端 UI、再到完整应用程序的完整技术栈。

## 架构总览

```
┌─────────────────────────────────────────────────────────────────────┐
│                         用户层应用                                   │
├─────────────────┬─────────────────┬─────────────────┬───────────────┤
│  pi (CLI)      │  Web UI         │  Mom (Slack)    │  SDK          │
│  coding-agent  │  web-ui         │  mom            │  coding-agent │
└────────┬────────┴────────┬────────┴────────┬────────┴───────┬─────────┘
         │                │                │               │
         ▼                ▼                ▼               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      Agent 核心层                                    │
│                         agent                                       │
└─────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       LLM 抽象层                                     │
│                          ai                                          │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │ 统一 API: stream/complete, 工具调用, Token 追踪, 跨模型切换      │ │
│  └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      终端渲染层                                       │
│                          tui                                         │
└─────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        Pod 部署层                                    │
│                         pods                                         │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 包详解

### 1. packages/ai - LLM 统一抽象层

**定位**: 底层 LLM API 封装库，提供统一的接口调用各种 LLM 提供商。

**核心功能**:
- **统一 API**: `stream()` 和 `complete()` 函数适配 20+ LLM 提供商
- **工具调用**: 基于 TypeBox 的类型安全工具定义和参数验证
- **Token 追踪**: 自动计算输入/输出 Token 和费用
- **思考/推理**: 支持 Claude、GPT、 Gemini 等模型的思考过程
- **跨模型切换**: 会话中无缝切换不同提供商的模型
- **上下文持久化**: 完整支持序列化和恢复对话上下文
- **OAuth 支持**: 自动处理 Anthropic、GitHub Copilot、Google Gemini CLI 等的 OAuth 认证

**支持的提供商**:
- OpenAI (ChatGPT Plus/Pro via Codex)
- Anthropic (Claude)
- Google (Gemini, Vertex AI)
- Azure OpenAI
- Amazon Bedrock
- Mistral, Groq, Cerebras, xAI
- OpenRouter, Vercel AI Gateway
- Ollama, vLLM, LM Studio (OpenAI 兼容)
- GitHub Copilot, Google Gemini CLI, Antigravity (OAuth)

**技术栈**: TypeScript, TypeBox, AJV

---

### 2. packages/agent - Agent 核心框架

**定位**: 有状态的 Agent 框架，基于 pi-ai 构建，提供工具执行和事件流。

**核心功能**:
- **状态管理**: 系统提示、模型、工具、会话历史的管理
- **事件系统**: 完整的事件流 (agent_start, turn_start, message_update, tool_execution 等)
- **工具执行**: 自动执行 LLM 调用的工具并返回结果
- **Steering/Follow-up**: 支持中断注入和消息队列
- **消息转换**: 可扩展的自定义消息类型系统

**技术栈**: TypeScript, 依赖 pi-ai

---

### 3. packages/tui - 终端 UI 框架

**定位**: 轻量级终端 UI 框架，支持差异化渲染和同步输出。

**核心功能**:
- **差异化渲染**: 三策略渲染系统，只更新变化的行
- **同步输出**: 使用 CSI 2026 实现原子屏幕更新，消除闪烁
- **组件系统**: 简单的 Component 接口，内置 Text、Editor、Input、SelectList 等
- **叠加层系统**: 支持模态对话框的堆栈管理
- **主题支持**: 可自定义的样式系统
- **内联图像**: 支持 Kitty/iTerm2 图像协议
- **自动补全**: 斜杠命令和文件路径补全
- **IME 支持**: 正确处理输入法候选窗口定位

**内置组件**: Container, Box, Text, TruncatedText, Input, Editor, Markdown, Loader, CancellableLoader, SelectList, SettingsList, Spacer, Image

**技术栈**: TypeScript, chalk (ANSI 样式)

---

### 4. packages/coding-agent - 终端编码助手

**定位**: 极简终端 AI 编程助手 (原名 "pi")，可适应不同工作流程。

**核心功能**:
- **四种模式**: 交互模式、打印模式、JSON 模式、RPC 模式
- **内置工具**: read, write, edit, bash, grep, find, ls
- **会话管理**: JSONL 文件存储，支持树形分支和上下文压缩
- **上下文文件**: 自动加载 AGENTS.md/CLAUDE.md
- **自定义扩展**:
  - 提示模板 (Prompt Templates)
  - 技能 (Skills) - Agent Skills 标准
  - 扩展 (Extensions) - TypeScript 模块
  - 主题 (Themes)
- **Pi 包**: 通过 npm/git 分享扩展
- **SDK**: 可嵌入其他应用

**技术栈**: TypeScript, Node.js, 依赖 pi-tui, pi-agent, pi-ai

---

### 5. packages/web-ui - Web UI 组件库

**定位**: 构建 AI 聊天界面的可复用 Web 组件，基于 pi-ai 和 pi-agent。

**核心功能**:
- **聊天界面**: 完整的消息历史、流式响应、工具执行
- **工具系统**: JavaScript REPL、文档提取、Artifacts (HTML, SVG, Markdown 等)
- **附件处理**: PDF, DOCX, XLSX, PPTX, 图片的预览和文本提取
- **Artifacts**: 沙盒执行的交互式 HTML/SVG/Markdown
- **存储**: IndexedDB 支持的会话、API 密钥、设置存储
- **CORS 代理**: 浏览器环境的自动代理处理
- **自定义提供商**: 支持 Ollama, LM Studio, vLLM, OpenAI 兼容 API

**技术栈**: TypeScript, mini-lit (Web Components), Tailwind CSS v4

---

### 6. packages/mom - Slack AI 机器人

**定位**: 运行在 Slack 中的 LLM 机器人，能执行命令、读写文件 (原名 "Master Of Mischief")。

**核心功能**:
- **Slack 集成**: 通过 Socket Mode 响应频道和 DM 中的 @mention
- **全栈 Bash 访问**: 执行任意命令、读写文件、自动化工作流
- **Docker 沙盒**: 隔离运行环境 (推荐)
- **持久化工作区**: 所有对话、文件、工具存储在用户控制的目录
- **工作记忆**: 跨会话记住上下文，创建自定义 CLI 工具 (Skills)
- **基于线程的详情**: 简洁的主消息，详细的工具调用在回复线程中
- **自管理**: 自动安装工具 (apk, npm 等)、配置凭证、维护工作区

**数据目录结构**:
```
data/
├── MEMORY.md           # 全局记忆
├── settings.json       # 全局设置
├── skills/             # 全局自定义工具
└── C123ABC/           # 每个 Slack 频道
    ├── MEMORY.md      # 频道记忆
    ├── log.jsonl      # 完整消息历史
    ├── context.jsonl  # LLM 上下文
    ├── attachments/   # 用户共享文件
    └── skills/        # 频道工具
```

**技术栈**: TypeScript, Node.js, 依赖 pi-ai, pi-agent

---

### 7. packages/pods - GPU Pod 部署工具

**定位**: 在远程 GPU Pod 上部署和管理 LLM 的 CLI 工具，自动配置 vLLM。

**核心功能**:
- **自动 vLLM 配置**: 在新 Pod 上自动设置 vLLM
- **工具调用配置**: 为 Qwen、GLM 等模型GPT-OSS、自动配置
- **多模型管理**: 同一 Pod 上运行多个模型，智能 GPU 分配
- **OpenAI 兼容 API**: 每个模型提供标准 API 端点
- **交互式 Agent**: 内置文件系统的测试代理
- **GPU 分配**: 内存百分比、上下文窗口、GPU 数量控制
- **预定义模型**: Qwen, GPT-OSS, GLM 等的开箱即用配置

**支持的提供商**:
- DataCrunch (最佳共享存储体验)
- RunPod
- Vast.ai, Prime Intellect, AWS EC2

**技术栈**: TypeScript, Node.js, SSH, vLLM

---

## 包依赖关系图

```
packages/coding-agent
    ├── packages/agent
    │   └── packages/ai
    ├── packages/tui
    │   └── packages/ai (可选)
    └── packages/ai (直接依赖)

packages/web-ui
    ├── packages/agent
    │   └── packages/ai
    └── packages/ai

packages/mom
    └── packages/agent
        └── packages/ai

packages/pods
    └── packages/ai (用于 pi-agent)

packages/tui (独立，无依赖)

packages/agent
    └── packages/ai

packages/ai (独立，无生产依赖)
```

---

## 技术栈总结

| 包 | 语言 | 运行时 | 关键依赖 |
|----|------|--------|----------|
| ai | TypeScript | Node.js/Browser | TypeBox, AJV |
| agent | TypeScript | Node.js/Browser | ai |
| tui | TypeScript | Node.js | chalk |
| coding-agent | TypeScript | Node.js | tui, agent, ai |
| web-ui | TypeScript | Browser | agent, ai, mini-lit, Tailwind |
| mom | TypeScript | Node.js | agent, ai |
| pods | TypeScript | Node.js | ai |

---

## 使用场景

| 场景 | 推荐包 |
|------|--------|
| 在代码中调用 LLM | packages/ai |
| 构建自定义 Agent 应用 | packages/agent + packages/ai |
| 构建终端 CLI 工具 | packages/tui |
| AI 编程助手 | packages/coding-agent |
| Web 聊天应用 | packages/web-ui |
| Slack 团队助手 | packages/mom |
| 私有 LLM 部署 | packages/pods |
