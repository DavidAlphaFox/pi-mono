# Agent.ts 深度分析

## 概述

`packages/agent/src/agent.ts` 是整个 Agent 系统的核心入口类，封装了智能体的完整生命周期管理。它是一个**有状态**的 Agent 框架，提供了简洁的命令式 API。

---

## 核心职责

| 职责 | 说明 |
|------|------|
| **状态管理** | 管理消息历史、流式状态、工具列表等 |
| **消息队列** | 支持干预消息 (steer) 和跟进消息 (followUp) |
| **事件发布** | 通过订阅机制向 UI 推送状态更新 |
| **流程控制** | prompt/continue/abort/reset |

---

## 架构设计

```
┌─────────────────────────────────────────────────────────────────┐
│                         用户代码                                 │
│  agent.prompt(), agent.steer(), agent.followUp()                │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Agent 类                                  │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐               │
│  │   状态      │ │  消息队列   │ │  事件系统   │               │
│  │ _state     │ │ steering   │ │ listeners  │               │
│  │            │ │ followUp   │ │ subscribe  │               │
│  └─────────────┘ └─────────────┘ └─────────────┘               │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                      agent-loop                                 │
│  处理 LLM 调用、工具执行、事件流                                  │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                       pi-ai                                     │
│  stream/complete, 20+ LLM 提供商                                │
└─────────────────────────────────────────────────────────────────┘
```

---

## 核心 API

### 1. 创建 Agent 实例

```typescript
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";

const agent = new Agent({
  // 初始状态
  initialState: {
    systemPrompt: "你是一个有帮助的助手",
    model: getModel("anthropic", "claude-sonnet-4-20250514"),
    thinkingLevel: "medium",  // off, minimal, low, medium, high, xhigh
    tools: [],               // 初始工具列表
    messages: [],            // 初始消息
  },

  // 消息转换函数 (必填)
  convertToLlm: (messages) => {
    // 过滤自定义消息类型，保留 LLM 兼容的消息
    return messages.filter(m => 
      m.role === "user" || m.role === "assistant" || m.role === "toolResult"
    );
  },

  // 上下文变换 (可选)
  transformContext: async (messages, signal) => {
    // 裁剪旧消息、注入外部上下文
    return messages;
  },

  // 干预消息模式
  steeringMode: "one-at-a-time",  // 或 "all"
  
  // 跟进消息模式  
  followUpMode: "one-at-a-time",  // 或 "all"

  // 自定义流函数 (可选)
  streamFn: streamSimple,

  // 会话 ID (用于提供商缓存)
  sessionId: "session-123",

  // 动态 API 密钥解析
  getApiKey: async (provider) => {
    return refreshToken();
  },

  // 思考预算
  thinkingBudgets: { minimal: 128, low: 512, medium: 1024, high: 2048 },

  // 传输方式
  transport: "sse",  // 或 "websocket", "auto"
});
```

### 2. 发送消息

```typescript
// 方式 1: 字符串
await agent.prompt("你好，请介绍一下自己");

// 方式 2: 字符串 + 图片
await agent.prompt("这张图片里有什么?", [
  { type: "image", data: "base64...", mimeType: "image/png" }
]);

// 方式 3: AgentMessage 对象
await agent.prompt({
  role: "user",
  content: "你好",
  timestamp: Date.now()
});

// 方式 4: 多个消息
await agent.prompt([
  { role: "user", content: "你好", timestamp: Date.now() },
  { role: "user", content: "今天怎么样?", timestamp: Date.now() }
]);
```

### 3. 干预机制

```typescript
// 干预消息 - 在工具执行完成后立即送达，跳过剩余工具
agent.steer({
  role: "user",
  content: "停！做这个 instead",
  timestamp: Date.now()
});

// 跟进消息 - 在 agent 完成后才送达
agent.followUp({
  role: "user", 
  content: "顺便总结一下",
  timestamp: Date.now()
});

// 查看队列状态
console.log(agent.hasQueuedMessages()); // true/false

// 清空队列
agent.clearSteeringQueue();
agent.clearFollowUpQueue();
agent.clearAllQueues();
```

### 4. 状态管理

```typescript
// 修改配置
agent.setSystemPrompt("新的系统提示");
agent.setModel(getModel("openai", "gpt-4o"));
agent.setThinkingLevel("high");
agent.setTools([myTool1, myTool2]);

// 修改消息
agent.replaceMessages(newMessages);  // 替换所有
agent.appendMessage(newMessage);      // 追加一条
agent.clearMessages();                // 清空

// 查看状态
console.log(agent.state.messages);    // 消息历史
console.log(agent.state.isStreaming);  // 是否在运行
console.log(agent.state.model);       // 当前模型
```

### 5. 流程控制

```typescript
// 继续运行 (用于重试或处理队列)
await agent.continue();

// 中止当前运行
agent.abort();

// 等待空闲
await agent.waitForIdle();  // 等待当前 prompt 完成

// 完全重置
agent.reset();  // 清空消息、状态、队列
```

### 6. 事件订阅

```typescript
// 订阅所有事件
agent.subscribe((event) => {
  switch (event.type) {
    case "agent_start":
      console.log("Agent 开始");
      break;
    case "agent_end":
      console.log("Agent 结束:", event.messages);
      break;
    case "turn_start":
      console.log("轮次开始");
      break;
    case "turn_end":
      console.log("轮次结束:", event.message, event.toolResults);
      break;
    case "message_start":
      console.log("消息开始:", event.message.role);
      break;
    case "message_update":
      // 流式更新！最重要的类型
      console.log("消息更新:", event.assistantMessageEvent);
      break;
    case "message_end":
      console.log("消息结束:", event.message);
      break;
    case "tool_execution_start":
      console.log("工具开始:", event.toolName, event.args);
      break;
    case "tool_execution_update":
      console.log("工具更新:", event.partialResult);
      break;
    case "tool_execution_end":
      console.log("工具结束:", event.result, event.isError);
      break;
  }
});

// 取消订阅
const unsubscribe = agent.subscribe(handler);
unsubscribe();
```

---

## 内部状态

```typescript
interface AgentState {
  systemPrompt: string;      // 系统提示
  model: Model;             // 当前模型
  thinkingLevel: ThinkingLevel;  // 思考级别
  tools: AgentTool[];       // 工具列表
  messages: AgentMessage[]; // 消息历史
  isStreaming: boolean;      // 是否在流式处理
  streamMessage: AgentMessage | null;  // 当前流式消息
  pendingToolCalls: Set<string>;       // 执行中的工具 ID
  error?: string;            // 错误信息
}
```

---

## 事件流详解

### 完整事件序列 (带工具调用)

```
prompt("读文件")
    │
    ├─ agent_start
    ├─ turn_start
    ├─ message_start      { role: "user" }     ← 你的消息
    ├─ message_end
    ├─ message_start      { role: "assistant" } ← LLM 开始响应
    ├─ message_update     { text_delta: "我将..." }
    ├─ message_update     { toolCall: readFile }
    ├─ message_end
    │
    ├─ tool_execution_start { toolCallId, toolName: "readFile", args }
    ├─ tool_execution_update { partialResult }  ← 可选：流式输出
    ├─ tool_execution_end   { result }
    │
    ├─ message_start      { role: "toolResult" }  ← 工具结果
    ├─ message_end
    │
    ├─ turn_end           { message, toolResults: [...] }
    │
    ├─ turn_start                                    ← 下一轮
    ├─ message_start      { role: "assistant" }
    ├─ message_update     { text_delta: "文件内容是..." }
    ├─ message_end
    ├─ turn_end
    └─ agent_end          { messages: [...] }
```

### 简单对话 (无工具)

```
prompt("你好")
    │
    ├─ agent_start
    ├─ turn_start
    ├─ message_start      { user }
    ├─ message_end
    ├─ message_start      { assistant }
    ├─ message_update     { text_delta: "你" }
    ├─ message_update     { text_delta: "好" }
    ├─ message_end
    ├─ turn_end
    └─ agent_end
```

---

## 完整使用示例

```typescript
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel, Type } from "@mariozechner/pi-ai";
import { TypeBox } from "@sinclair/typebox";

// 1. 定义工具
const readFileTool = {
  name: "read_file",
  label: "读取文件",
  description: "读取文件内容",
  parameters: Type.Object({
    path: Type.String({ description: "文件路径" }),
  }),
  execute: async (toolCallId, params, signal) => {
    const content = await Bun.file(params.path).text();
    return {
      content: [{ type: "text", text: content }],
      details: { path: params.path, size: content.length },
    };
  },
};

const calculatorTool = {
  name: "calculator",
  label: "计算器",
  description: "执行数学计算",
  parameters: Type.Object({
    expression: Type.String({ description: "数学表达式" }),
  }),
  execute: async (toolCallId, params) => {
    // 安全计算
    const result = Function(`"use strict"; return (${params.expression})`)();
    return {
      content: [{ type: "text", text: String(result) }],
      details: { expression: params.expression, result },
    };
  },
};

// 2. 创建 Agent
const agent = new Agent({
  initialState: {
    systemPrompt: "你是一个有帮助的编程助手。",
    model: getModel("anthropic", "claude-sonnet-4-20250514"),
    thinkingLevel: "medium",
    tools: [readFileTool, calculatorTool],
  },
  convertToLlm: (messages) => {
    // 过滤消息，只保留 LLM 兼容的类型
    return messages.filter(m => 
      m.role === "user" || 
      m.role === "assistant" || 
      m.role === "toolResult"
    );
  },
});

// 3. 订阅事件 (用于 UI 更新)
agent.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    // 流式输出文本
    process.stdout.write(event.assistantMessageEvent.delta);
  }
  
  if (event.type === "tool_execution_start") {
    console.log(`\n🔧 执行工具: ${event.toolName}`);
  }
  
  if (event.type === "tool_execution_end") {
    if (event.isError) {
      console.log(`❌ 工具错误: ${event.result}`);
    } else {
      console.log(`✅ 工具完成:`, event.result);
    }
  }
});

// 4. 运行
async function main() {
  // 简单对话
  await agent.prompt("你好！");
  
  // 带工具调用
  await agent.prompt("帮我计算 2 + 3 * 4");
  
  // 干预机制示例
  agent.steer({
    role: "user",
    content: "停！先告诉我 2+3 等于多少",
    timestamp: Date.now()
  });
  
  // 使用跟进消息
  agent.followUp({
    role: "user",
    content: "顺便把结果保存到文件",
    timestamp: Date.now()
  });
  
  // 继续执行
  await agent.continue();
  
  // 查看最终消息
  console.log("\n\n--- 最终消息 ---");
  for (const msg of agent.state.messages) {
    console.log(`${msg.role}:`, msg.content);
  }
}

main();
```

---

## 与低层 API 的区别

Agent 类 vs agent-loop (低层 API):

| 特性 | Agent 类 | agent-loop |
|------|---------|------------|
| 抽象级别 | 高层 (命令式) | 低层 (函数式) |
| 状态管理 | 内置 | 需手动管理 |
| 消息队列 | 内置 | 需手动实现 |
| 事件系统 | 简化 | 完整控制 |
| 使用场景 | 应用开发 | 框架/库开发 |

```typescript
// 低层 API 示例 (需要更多手动控制)
import { agentLoop, agentLoopContinue } from "@mariozechner/pi-agent-core";

const context = {
  systemPrompt: "...",
  messages: [],
  tools: [myTool],
};

const config = {
  model: getModel("anthropic", "claude-sonnet-4-20250514"),
  convertToLlm: (msgs) => msgs.filter(...),
};

for await (const event of agentLoop([userMsg], context, config)) {
  // 手动处理每个事件
}
```

---

## 关键设计点

1. **消息转换**: `convertToLlm` 桥接应用消息和 LLM 消息
2. **事件驱动**: 所有状态变化通过事件通知
3. **可扩展**: 支持自定义消息类型 (TypeScript 声明合并)
4. **工具执行**: 自动执行 + 参数验证 + 流式更新
5. **干预机制**: steer (中断) vs followUp (完成后)

---

## Agent 与 agent-loop 的关系

### 架构层次

```
┌─────────────────────────────────────────────────────────────────┐
│                        用户代码                                   │
│                                                                 │
│  const agent = new Agent({...});                               │
│  await agent.prompt("你好");                                    │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Agent 类                                    │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  • 管理状态 (_state, messages, queues)                   │    │
│  │  • 暴露高层 API (prompt, steer, followUp)               │    │
│  │  • 处理事件 (emit to listeners)                         │    │
│  │  • 调用 agentLoop() 驱动循环                            │    │
│  └─────────────────────────────────────────────────────────┘    │
│                           │                                     │
│                           ▼                                     │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  this._runLoop() {                                     │    │
│  │    agentLoop(messages, context, config)  ← 调用这里      │    │
│  │  }                                                     │    │
│  └─────────────────────────────────────────────────────────┘    │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                     agent-loop                                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  • 无状态纯函数                                         │    │
│  │  • 核心循环逻辑 (LLM调用 → 工具执行 → 检查队列)         │    │
│  │  • 发出事件 (message_update, tool_execution_*, etc)    │    │
│  └─────────────────────────────────────────────────────────┘    │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                       pi-ai                                     │
│  streamSimple() → LLM API                                       │
└─────────────────────────────────────────────────────────────────┘
```

### 代码对应关系

```typescript
// Agent 类内部 (agent.ts:639-641)
private async _runLoop(messages?: AgentMessage[]) {
  const stream = messages
    ? agentLoop(messages, context, config, signal, this.streamFn)  // ← 调用
    : agentLoopContinue(context, config, signal, this.streamFn);
  
  // 消费事件，更新内部状态
  for await (const event of stream) {
    switch (event.type) {
      case "message_update":
        this._state.streamMessage = event.message;
        break;
      case "message_end":
        this.appendMessage(event.message);
        break;
      // ...
    }
    // 转发给订阅者
    this.emit(event);
  }
}
```

### 职责划分

| Agent 类 | agent-loop |
|----------|------------|
| 管理消息历史 | 不存储消息 |
| 管理干预/跟进队列 | 通过回调获取队列 |
| 暴露 `prompt()` API | 提供底层循环 |
| 错误处理包装 | 原始事件流 |
| 状态持久化 | 纯逻辑 |

### 简单比喻

- **agent-loop**: 汽车的发动机 + 变速箱 (动力系统)
- **Agent 类**: 汽车的方向盘 + 仪表盘 + 钥匙 (控制界面)

你需要的是汽车，而不是发动机。但 Agent 类底层用的是 agent-loop。

### 何时使用哪个

| 场景 | 推荐 |
|------|------|
| 构建应用 | Agent 类 |
| 构建框架/库 | agent-loop |
| 需要手动状态管理 | agent-loop |
| 需要细粒度控制 | agent-loop |
| 快速开发 | Agent 类 |
