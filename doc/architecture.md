# Pi-Mono 架构文档

## 项目概述

Pi-Mono 是一个 TypeScript/Node.js 单体仓库（monorepo），包含 7 个核心包，构建了一套完整的 AI 编程助手系统。支持 20+ LLM 提供商，提供终端 TUI、Web UI、Slack Bot 等多种交互方式。

## 整体架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                        应用层 (Applications)                         │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────┐  ┌────────────┐  │
│  │ coding-agent │  │   web-ui     │  │   mom    │  │   pods     │  │
│  │  (终端CLI)   │  │  (Web界面)   │  │(Slack机器│  │(GPU Pod管理)│  │
│  │              │  │              │  │   人)    │  │            │  │
│  └──────┬───────┘  └──────┬───────┘  └────┬─────┘  └─────┬──────┘  │
│         │                 │               │               │         │
├─────────┼─────────────────┼───────────────┼───────────────┼─────────┤
│         │           框架层 (Framework)     │               │         │
│         │                 │               │               │         │
│  ┌──────┴───────┐         │               │               │         │
│  │    tui       │         │               │               │         │
│  │ (终端UI框架) │         │               │               │         │
│  └──────────────┘         │               │               │         │
│                           │               │               │         │
├───────────────────────────┼───────────────┼───────────────┼─────────┤
│                      核心层 (Core)        │               │         │
│                           │               │               │         │
│              ┌────────────┴───────────────┴───────────────┘         │
│              │                                                      │
│       ┌──────┴───────┐                                              │
│       │  agent-core  │                                              │
│       │ (智能体核心) │                                              │
│       └──────┬───────┘                                              │
│              │                                                      │
├──────────────┼──────────────────────────────────────────────────────┤
│         基础层 (Foundation)                                         │
│              │                                                      │
│       ┌──────┴───────┐                                              │
│       │    pi-ai     │                                              │
│       │ (统一LLM API)│                                              │
│       └──────┬───────┘                                              │
│              │                                                      │
│   ┌──────────┼──────────────────────────────────────┐               │
│   │          │          LLM 提供商                   │               │
│   │  ┌───┐ ┌┴──┐ ┌────┐ ┌───┐ ┌────┐ ┌─────┐      │               │
│   │  │OAI│ │Ant│ │Goog│ │AWS│ │Azur│ │其他..│      │               │
│   │  └───┘ └───┘ └────┘ └───┘ └────┘ └─────┘      │               │
│   └─────────────────────────────────────────────────┘               │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## 包依赖关系图

```
                    ┌─────────┐
                    │  pi-ai  │  ← 基础包：统一 LLM API
                    └────┬────┘
                         │
                    ┌────┴────┐
                    │  agent  │  ← 核心包：智能体状态管理
                    │  -core  │
                    └────┬────┘
                         │
          ┌──────────────┼──────────────┬────────────┐
          │              │              │            │
    ┌─────┴─────┐  ┌─────┴─────┐  ┌────┴───┐  ┌────┴───┐
    │  coding-  │  │  web-ui   │  │  mom   │  │  pods  │
    │  agent    │  │           │  │        │  │        │
    └─────┬─────┘  └───────────┘  └────────┘  └────────┘
          │
    ┌─────┴─────┐
    │   tui     │  ← 仅 coding-agent 依赖
    └───────────┘
```

## 各包详细架构

---

### 1. pi-ai（统一 LLM API 层）

**路径**: `packages/ai/`
**职责**: 为 20+ LLM 提供商提供统一的 API 抽象

```
packages/ai/src/
├── index.ts                  # 主入口，导出所有公共 API
├── types.ts                  # 核心类型定义（Provider, StreamOptions, ThinkingLevel 等）
├── api-registry.ts           # API/提供商注册中心
├── models.ts                 # 模型管理逻辑
├── models.generated.ts       # 自动生成的模型目录（328KB）
├── stream.ts                 # 流式传输工具
├── cli.ts                    # CLI 接口
├── env-api-keys.ts           # 环境变量 API 密钥管理
│
├── providers/                # 各 LLM 提供商实现
│   ├── anthropic.ts          #   Anthropic (Claude)
│   ├── openai-responses.ts   #   OpenAI (Responses API)
│   ├── openai-completions.ts #   OpenAI (Completions API)
│   ├── google.ts             #   Google Gemini
│   ├── google-vertex.ts      #   Google Vertex AI
│   ├── amazon-bedrock.ts     #   AWS Bedrock
│   ├── azure-openai-*.ts     #   Azure OpenAI
│   ├── register-builtins.ts  #   内置提供商注册
│   ├── transform-messages.ts #   消息格式转换
│   └── simple-options.ts     #   简化选项构建
│
└── utils/                    # 工具函数
    ├── oauth/                #   OAuth2 认证
    │   ├── anthropic.ts      #     Anthropic OAuth
    │   ├── github-copilot.ts #     GitHub Copilot OAuth
    │   ├── google-*.ts       #     Google OAuth
    │   ├── openai-codex.ts   #     OpenAI Codex OAuth
    │   ├── pkce.ts           #     PKCE 工具
    │   └── types.ts          #     OAuth 类型定义
    ├── event-stream.ts       #   SSE 事件流解析
    ├── http-proxy.ts         #   HTTP 代理
    ├── json-parse.ts         #   JSON 解析工具
    ├── validation.ts         #   输入验证
    ├── overflow.ts           #   溢出处理
    ├── sanitize-unicode.ts   #   Unicode 清理
    └── typebox-helpers.ts    #   TypeBox 类型辅助
```

**核心流程**:
```
用户请求 → StreamOptions → API Registry → Provider 实现 → LLM API 调用
                                                           ↓
                                              流式响应 ← 令牌/成本追踪
```

---

### 2. agent-core（智能体核心层）

**路径**: `packages/agent/`
**职责**: 提供有状态的智能体循环、工具执行和事件流

```
packages/agent/src/
├── index.ts        # 主入口
├── types.ts        # 类型定义（AgentMessage, AgentState, AgentTool, AgentEvent）
├── agent.ts        # Agent 类 - 高级智能体状态管理
├── agent-loop.ts   # AgentLoop - 底层智能体执行循环
└── proxy.ts        # 代理工具（浏览器/后端场景）
```

**智能体生命周期**:
```
agent_start
  └→ turn_start
       └→ message_start
            └→ message_update (流式)
            └→ tool_execution_start
                 └→ tool_execution_update
                 └→ tool_execution_end
            └→ message_end
       └→ turn_end
  └→ agent_end
```

---

### 3. tui（终端 UI 框架）

**路径**: `packages/tui/`
**职责**: 提供差异化渲染、组件化的终端用户界面框架

```
packages/tui/src/
├── index.ts             # 主入口
├── tui.ts               # TUI 主类 - 组件管理、渲染循环
├── terminal.ts          # 终端接口和 ProcessTerminal 实现
├── terminal-image.ts    # 图片渲染（Kitty/iTerm2 协议）
├── keys.ts              # 键盘输入解析（支持 Kitty 协议）
├── keybindings.ts       # 编辑器快捷键配置
├── editor-component.ts  # 编辑器组件接口
├── autocomplete.ts      # 自动补全系统
├── utils.ts             # 文本处理工具（宽度计算、截断、换行）
├── fuzzy.ts             # 模糊搜索
├── kill-ring.ts         # Kill Ring（剪贴板环）
├── undo-stack.ts        # 撤销栈
├── stdin-buffer.ts      # 标准输入缓冲
│
└── components/          # 内置组件
    ├── text.ts          #   文本组件
    ├── truncated-text.ts#   截断文本组件
    ├── input.ts         #   输入框组件
    ├── editor.ts        #   编辑器组件
    ├── markdown.ts      #   Markdown 渲染组件
    ├── select-list.ts   #   选择列表组件
    ├── settings-list.ts #   设置列表组件
    ├── loader.ts        #   加载器组件
    ├── cancellable-loader.ts # 可取消加载器
    ├── image.ts         #   图片组件
    ├── box.ts           #   盒子容器组件
    └── spacer.ts        #   间距组件
```

**渲染流程**:
```
组件树 → 行缓冲区 → 差异计算 → 仅更新变化行 → 终端输出
                                                  ↓
                              CSI 2026 同步输出（防闪烁）
```

---

### 4. coding-agent（编码智能体 - 主应用）

**路径**: `packages/coding-agent/`
**职责**: CLI 编码智能体，集成交互式 TUI、会话管理、扩展系统

```
packages/coding-agent/src/
├── cli.ts               # CLI 入口
├── main.ts              # 主应用逻辑
├── index.ts             # SDK 导出
├── config.ts            # 配置管理
├── migrations.ts        # 会话迁移逻辑
│
├── cli/                 # CLI 子命令
│   ├── args.ts          #   命令行参数解析
│   ├── config-selector.ts #  配置选择器
│   ├── file-processor.ts #  文件处理器
│   ├── list-models.ts   #   模型列表
│   └── session-picker.ts #  会话选择器
│
├── core/                # 核心模块
│   ├── index.ts         #   核心导出
│   ├── agent-session.ts #   AgentSession 类 - 会话管理核心
│   ├── session-manager.ts # SessionManager - 会话持久化
│   ├── model-registry.ts #  模型配置注册中心
│   ├── model-resolver.ts #  动态模型解析
│   ├── settings-manager.ts # 设置管理器
│   ├── auth-storage.ts  #   认证存储
│   ├── bash-executor.ts #   Bash 命令执行器
│   ├── event-bus.ts     #   事件总线（扩展通信）
│   ├── skills.ts        #   技能系统
│   ├── slash-commands.ts #  斜杠命令注册
│   ├── prompt-templates.ts # 提示词模板
│   ├── system-prompt.ts #   系统提示词构建
│   ├── keybindings.ts   #   快捷键管理
│   ├── diagnostics.ts   #   诊断和性能追踪
│   ├── messages.ts      #   消息处理
│   ├── defaults.ts      #   默认配置
│   ├── exec.ts          #   命令执行工具
│   ├── timings.ts       #   计时工具
│   ├── sdk.ts           #   SDK 工厂函数
│   ├── footer-data-provider.ts # 底栏数据
│   ├── package-manager.ts #  包管理器检测
│   ├── resolve-config-value.ts # 配置值解析
│   ├── resource-loader.ts #  资源加载器
│   │
│   ├── tools/           #   工具集
│   │   ├── index.ts     #     工具注册
│   │   ├── bash.ts      #     Bash 执行工具
│   │   ├── read.ts      #     文件读取工具
│   │   ├── write.ts     #     文件写入工具
│   │   ├── edit.ts      #     文件编辑工具
│   │   ├── edit-diff.ts #     差异编辑工具
│   │   ├── grep.ts      #     内容搜索工具
│   │   ├── find.ts      #     文件查找工具
│   │   ├── ls.ts        #     目录列表工具
│   │   ├── path-utils.ts #   路径工具
│   │   └── truncate.ts  #     输出截断工具
│   │
│   ├── compaction/      #   上下文压缩
│   │   ├── index.ts     #     导出
│   │   ├── compaction.ts #    压缩逻辑
│   │   ├── branch-summarization.ts # 分支摘要
│   │   └── utils.ts     #     工具函数
│   │
│   ├── extensions/      #   扩展系统
│   │   ├── index.ts     #     导出
│   │   ├── types.ts     #     扩展类型定义
│   │   ├── loader.ts    #     扩展发现和加载
│   │   ├── runner.ts    #     扩展执行
│   │   └── wrapper.ts   #     工具包装器
│   │
│   └── export-html/     #   HTML 导出
│       ├── index.ts     #     导出
│       ├── ansi-to-html.ts # ANSI 转 HTML
│       └── tool-renderer.ts # 工具渲染器
│
├── modes/               # 运行模式
│   ├── index.ts         #   模式导出
│   ├── print-mode.ts    #   打印模式（JSON/CLI 输出）
│   │
│   ├── interactive/     #   交互模式（主 TUI）
│   │   ├── interactive-mode.ts # 交互模式主实现
│   │   ├── theme/       #     主题系统
│   │   │   └── theme.ts #       主题管理
│   │   └── components/  #     UI 组件（35+）
│   │       ├── index.ts
│   │       ├── assistant-message.ts  # 助手消息
│   │       ├── user-message.ts       # 用户消息
│   │       ├── bash-execution.ts     # Bash 执行显示
│   │       ├── tool-execution.ts     # 工具执行显示
│   │       ├── diff.ts               # 差异显示
│   │       ├── footer.ts             # 底栏
│   │       ├── model-selector.ts     # 模型选择器
│   │       ├── session-selector.ts   # 会话选择器
│   │       ├── settings-selector.ts  # 设置选择器
│   │       ├── theme-selector.ts     # 主题选择器
│   │       └── ...                   # 更多组件
│   │
│   └── rpc/             #   RPC 模式（进程间通信）
│       ├── rpc-mode.ts  #     RPC 模式实现
│       ├── rpc-client.ts #    RPC 客户端
│       └── rpc-types.ts #     RPC 类型定义
│
└── utils/               # 工具函数
    └── changelog.ts     #   变更日志工具
```

**应用架构流程**:
```
CLI 入口 (cli.ts)
    ↓
主逻辑 (main.ts) → 选择运行模式
    ├── 交互模式 (interactive-mode.ts) → TUI 组件渲染
    ├── 打印模式 (print-mode.ts) → JSON 输出
    └── RPC 模式 (rpc-mode.ts) → stdio 通信

    ↓ 所有模式共享
AgentSession → Agent (agent-core) → pi-ai → LLM
    ↓
工具执行 (bash/read/write/edit/grep/find/ls)
    ↓
扩展系统 → 事件总线 → 技能/斜杠命令
```

---

### 5. mom（Slack 机器人）

**路径**: `packages/mom/`
**职责**: Slack 聊天机器人，集成 coding-agent 执行代码任务

```
packages/mom/src/
├── main.ts        # 入口 - 机器人初始化和事件循环
├── agent.ts       # 智能体集成 - 消息处理（核心逻辑）
├── slack.ts       # Slack API 封装
├── context.ts     # 会话上下文管理
├── events.ts      # 事件处理
├── store.ts       # 状态持久化
├── log.ts         # 日志系统
├── download.ts    # 文件下载
├── sandbox.ts     # 沙箱运行时
│
└── tools/         # 自定义工具集
    ├── index.ts   #   工具注册
    ├── bash.ts    #   Bash 工具
    ├── read.ts    #   读取工具
    ├── write.ts   #   写入工具
    ├── edit.ts    #   编辑工具
    ├── attach.ts  #   附件工具
    └── truncate.ts #  截断工具
```

---

### 6. web-ui（Web 用户界面）

**路径**: `packages/web-ui/`
**职责**: 可复用的 Web 组件库，用于构建 AI 聊天界面

```
packages/web-ui/src/
├── index.ts                  # 主入口
├── ChatPanel.ts              # 聊天面板主组件
│
├── components/               # UI 组件
│   ├── AgentInterface.ts     #   智能体接口组件
│   ├── MessageList.ts        #   消息列表
│   ├── MessageEditor.ts      #   消息编辑器
│   ├── Messages.ts           #   消息渲染
│   ├── Input.ts              #   输入组件
│   ├── AttachmentTile.ts     #   附件瓦片
│   ├── ConsoleBlock.ts       #   控制台块
│   ├── ExpandableSection.ts  #   可展开区域
│   ├── ThinkingBlock.ts      #   思考块
│   ├── StreamingMessageContainer.ts # 流式消息容器
│   ├── SandboxedIframe.ts    #   沙箱 iframe
│   ├── CustomProviderCard.ts #   自定义提供商卡片
│   ├── ProviderKeyInput.ts   #   API Key 输入
│   ├── message-renderer-registry.ts # 消息渲染器注册
│   │
│   └── sandbox/              #   沙箱运行时
│       ├── SandboxRuntimeProvider.ts     # 沙箱运行时提供者
│       ├── RuntimeMessageBridge.ts       # 运行时消息桥
│       ├── RuntimeMessageRouter.ts       # 消息路由器
│       ├── ArtifactsRuntimeProvider.ts   # 制品运行时
│       ├── AttachmentsRuntimeProvider.ts # 附件运行时
│       ├── ConsoleRuntimeProvider.ts     # 控制台运行时
│       └── FileDownloadRuntimeProvider.ts # 文件下载运行时
│
├── dialogs/                  # 对话框
│   ├── ModelSelector.ts      #   模型选择器
│   ├── SettingsDialog.ts     #   设置对话框
│   ├── SessionListDialog.ts  #   会话列表
│   ├── ApiKeyPromptDialog.ts #   API Key 提示
│   ├── AttachmentOverlay.ts  #   附件覆盖层
│   ├── CustomProviderDialog.ts # 自定义提供商
│   ├── ProvidersModelsTab.ts #   提供商/模型标签页
│   └── PersistentStorageDialog.ts # 持久化存储
│
├── tools/                    # 工具系统
│   ├── index.ts              #   工具导出
│   ├── renderer-registry.ts  #   工具渲染器注册
│   ├── types.ts              #   工具类型定义
│   ├── javascript-repl.ts    #   JS REPL 工具
│   ├── extract-document.ts   #   文档提取工具
│   │
│   ├── artifacts/            #   制品系统
│   │   ├── index.ts          #     导出
│   │   ├── artifacts.ts      #     制品工具定义
│   │   ├── artifacts-tool-renderer.ts # 制品渲染器
│   │   ├── ArtifactElement.ts #    制品元素基类
│   │   ├── ArtifactPill.ts   #     制品药丸组件
│   │   ├── Console.ts        #     控制台制品
│   │   ├── HtmlArtifact.ts   #     HTML 制品
│   │   ├── SvgArtifact.ts    #     SVG 制品
│   │   ├── ImageArtifact.ts  #     图片制品
│   │   ├── MarkdownArtifact.ts #   Markdown 制品
│   │   ├── TextArtifact.ts   #     文本制品
│   │   ├── PdfArtifact.ts    #     PDF 制品
│   │   ├── DocxArtifact.ts   #     DOCX 制品
│   │   ├── ExcelArtifact.ts  #     Excel 制品
│   │   └── GenericArtifact.ts #    通用制品
│   │
│   └── renderers/            #   工具渲染器
│       ├── DefaultRenderer.ts #    默认渲染器
│       ├── BashRenderer.ts   #     Bash 渲染器
│       ├── CalculateRenderer.ts #  计算器渲染器
│       └── GetCurrentTimeRenderer.ts # 时间渲染器
│
├── storage/                  # 存储系统
│   ├── app-storage.ts        #   应用存储管理
│   ├── store.ts              #   通用存储基类
│   ├── types.ts              #   存储类型定义
│   ├── backends/             #   存储后端
│   │   └── indexeddb-storage-backend.ts # IndexedDB 后端
│   └── stores/               #   具体存储
│       ├── custom-providers-store.ts # 自定义提供商
│       ├── provider-keys-store.ts    # API Key 存储
│       ├── sessions-store.ts         # 会话存储
│       └── settings-store.ts         # 设置存储
│
├── utils/                    # 工具函数
│   ├── attachment-utils.ts   #   附件处理
│   ├── auth-token.ts         #   认证令牌
│   ├── format.ts             #   格式化
│   ├── i18n.ts               #   国际化
│   ├── model-discovery.ts    #   模型发现
│   ├── proxy-utils.ts        #   代理工具
│   └── test-sessions.ts      #   测试会话
│
└── prompts/                  # 提示词
    └── prompts.ts            #   提示词定义
```

---

### 7. pods（GPU Pod 管理）

**路径**: `packages/pods/`
**职责**: CLI 工具，管理 vLLM 在 GPU Pod 上的部署

```
packages/pods/src/
├── cli.ts            # CLI 入口
├── index.ts          # 主入口
├── config.ts         # 配置管理
├── types.ts          # 类型定义
├── ssh.ts            # SSH 工具（Pod 访问）
├── model-configs.ts  # 模型配置
│
└── commands/         # CLI 命令
    ├── models.ts     #   模型管理命令
    ├── pods.ts       #   Pod 管理命令
    └── prompt.ts     #   提示词命令
```

---

## 数据流架构

```
┌─────────┐     ┌───────────┐     ┌──────────┐     ┌─────────┐
│ 用户输入 │ ──→ │  会话管理  │ ──→ │ 智能体循环│ ──→ │  LLM API │
│(TUI/Web/ │     │(AgentSess-│     │(AgentLoop)│     │ (pi-ai)  │
│ Slack)   │     │  ion)     │     │           │     │          │
└─────────┘     └───────────┘     └─────┬─────┘     └────┬─────┘
                                        │                 │
                                        │ 工具调用         │ 流式响应
                                        ↓                 ↓
                                  ┌───────────┐     ┌──────────┐
                                  │  工具执行   │     │ 令牌追踪  │
                                  │ (bash/read │     │ 成本计算  │
                                  │  /write等) │     │          │
                                  └───────────┘     └──────────┘
                                        │
                                        ↓
                                  ┌───────────┐
                                  │  扩展系统   │
                                  │ (事件总线 → │
                                  │  技能/命令) │
                                  └───────────┘
```

## 会话管理架构

```
┌─────────────────────────────────────────┐
│           SessionManager                 │
│  ┌─────────────────────────────────┐    │
│  │       AgentSession              │    │
│  │  ┌──────────┐ ┌─────────────┐   │    │
│  │  │ 消息历史  │ │  分支管理    │   │    │
│  │  │          │ │             │   │    │
│  │  └──────────┘ └─────────────┘   │    │
│  │  ┌──────────┐ ┌─────────────┐   │    │
│  │  │ 上下文压缩│ │  工具状态    │   │    │
│  │  │(Compacti-│ │             │   │    │
│  │  │ on)      │ │             │   │    │
│  │  └──────────┘ └─────────────┘   │    │
│  └─────────────────────────────────┘    │
│                                         │
│  持久化 → JSON 文件 / IndexedDB          │
└─────────────────────────────────────────┘
```

## 扩展系统架构

```
┌──────────────────────────────────────────────┐
│              扩展系统 (Extensions)             │
│                                              │
│  ┌──────────┐   加载    ┌───────────────┐    │
│  │  Loader  │ ────────→ │  扩展定义文件   │    │
│  │ (发现)   │           │  (YAML/JSON)  │    │
│  └────┬─────┘           └───────────────┘    │
│       │                                      │
│       ↓ 注册                                  │
│  ┌──────────┐                                │
│  │  Runner  │ ←── 事件总线 (EventBus)         │
│  │ (执行)   │                                │
│  └────┬─────┘                                │
│       │                                      │
│       ↓ 包装                                  │
│  ┌──────────┐                                │
│  │ Wrapper  │ → 拦截工具调用 → 修改行为       │
│  │ (包装)   │                                │
│  └──────────┘                                │
└──────────────────────────────────────────────┘
```

## 技术栈

| 层次 | 技术 |
|------|------|
| 语言 | TypeScript (Node.js >= 20) |
| 构建 | tsgo + tsx |
| 代码质量 | Biome 2.3.5 |
| 包管理 | npm workspaces |
| 终端渲染 | 自研差异化渲染 + CSI 2026 |
| Web 组件 | mini-lit (自研 Lit 精简版) |
| 样式 | Tailwind CSS (Web) / chalk (终端) |
| LLM SDK | Anthropic, OpenAI, Google GenAI, AWS Bedrock, Mistral |
| 认证 | OAuth2 + PKCE |
| 存储 | JSON 文件 (CLI) / IndexedDB (Web) |
| 通信 | Slack Socket Mode (mom) / stdio RPC (coding-agent) |

## 构建顺序

```
tui → ai → agent-core → coding-agent → mom → web-ui → pods
```

构建必须按此顺序，因为后续包依赖前置包的编译产物。
