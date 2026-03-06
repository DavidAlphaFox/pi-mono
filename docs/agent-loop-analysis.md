# Agent Loop 深度解析

## 什么是 Agent Loop?

`agent-loop.ts` 是 **无状态** 的智能体循环核心实现。它是 Agent 类的底层引擎，负责:
- 调用 LLM 获取响应
- 执行工具调用
- 处理干预/跟进消息
- 发出事件

与 Agent 类对比:

| 特性 | Agent 类 | agent-loop |
|------|---------|------------|
| 状态 | 有状态 | 无状态 |
| 抽象 | 高层 API | 底层 API |
| 使用场景 | 应用开发 | 框架/库开发 |

---

## 核心函数

### 1. agentLoop - 启动新循环

```typescript
import { agentLoop } from "@mariozechner/pi-agent-core";

const stream = agentLoop(
  [userMessage],           // 初始提示消息
  context,                // 上下文 (系统提示、消息历史、工具)
  config,                 // 配置 (模型、转换函数等)
  abortSignal,            // 可选：中止信号
  customStreamFn          // 可选：自定义流函数
);

// 消费事件流
for await (const event of stream) {
  console.log(event.type);
}

// 获取最终消息
const messages = await stream.result();
```

### 2. agentLoopContinue - 继续现有循环

```typescript
import { agentLoopContinue } from "@mariozechner/pi-agent-core";

// 用于重试或处理队列消息
const stream = agentLoopContinue(
  context,    // 必须包含消息历史
  config,
  abortSignal,
  customStreamFn
);
```

---

## 循环流程图

```
                    ┌─────────────────────────────────────────┐
                    │           agentLoop()                   │
                    │  接收 prompts + context + config         │
                    └──────────────────┬──────────────────────┘
                                       │
                                       ▼
                    ┌─────────────────────────────────────────┐
                    │          emit: agent_start              │
                    │          emit: turn_start               │
                    │  将 prompts 添加到 context.messages      │
                    └──────────────────┬──────────────────────┘
                                       │
                                       ▼
                    ┌─────────────────────────────────────────┐
                    │              runLoop()                   │
                    │  ┌─────────────────────────────────────┐ │
                    │  │  外层循环: while(true)               │ │
                    │  │    ├─ 检查 pendingMessages          │ │
                    │  │    ├─ LLM 调用 (streamAssistant)   │ │
                    │  │    ├─ 执行工具 (executeToolCalls)   │ │
                    │  │    ├─ 检查干预消息                  │ │
                    │  │    └─ 检查跟进消息                  │ │
                    │  └─────────────────────────────────────┘ │
                    └──────────────────┬──────────────────────┘
                                       │
                    ┌──────────────────▼──────────────────────┐
                    │          emit: agent_end                │
                    │          return: newMessages              │
                    └─────────────────────────────────────────┘
```

---

## 核心流程详解

### 步骤 1: streamAssistantResponse - LLM 调用

```typescript
// 1. 应用上下文变换 (transformContext)
let messages = context.messages;
if (config.transformContext) {
  messages = await config.transformContext(messages, signal);
}

// 2. 转换为 LLM 消息格式
const llmMessages = await config.convertToLlm(messages);

// 3. 构建上下文并调用 LLM
const llmContext = {
  systemPrompt: context.systemPrompt,
  messages: llmMessages,
  tools: context.tools,
};

const response = await streamFunction(config.model, llmContext, options);

// 4. 消费流式事件，发出 Agent 事件
for await (const event of response) {
  if (event.type === "text_delta") {
    stream.push({
      type: "message_update",
      assistantMessageEvent: event,
      message: partialMessage
    });
  }
  // ... 处理其他事件
}
```

### 步骤 2: executeToolCalls - 工具执行

```typescript
// 顺序执行每个工具调用
for (const toolCall of toolCalls) {
  // 发出开始事件
  stream.push({
    type: "tool_execution_start",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
  });

  try {
    // 校验参数
    const validatedArgs = validateToolArguments(tool, toolCall);
    
    // 执行工具
    result = await tool.execute(toolCall.id, validatedArgs, signal, onUpdate);
  } catch (e) {
    // 错误转为工具结果
    result = { content: [{ type: "text", text: e.message }] };
    isError = true;
  }

  // 发出结束事件
  stream.push({
    type: "tool_execution_end",
    toolCallId: toolCall.id,
    result,
    isError,
  });

  // 每次工具执行后检查干预消息
  if (getSteeringMessages) {
    const steering = await getSteeringMessages();
    if (steering.length > 0) {
      // 跳过剩余工具
      break;
    }
  }
}
```

---

## 完整使用示例

```typescript
import { 
  agentLoop, 
  agentLoopContinue,
  getModel 
} from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

// 1. 定义工具
const myTool = {
  name: "my_tool",
  description: "我的工具",
  parameters: Type.Object({ arg: Type.String() }),
  execute: async (id, params) => {
    return {
      content: [{ type: "text", text: `执行: ${params.arg}` }],
      details: {},
    };
  },
};

// 2. 构建上下文
const context = {
  systemPrompt: "你是一个助手",
  messages: [
    { role: "user", content: "你好", timestamp: Date.now() }
  ],
  tools: [myTool],
};

// 3. 构建配置
const config = {
  model: getModel("anthropic", "claude-sonnet-4-20250514"),
  
  // 必填: 转换函数
  convertToLlm: (messages) => messages.filter(m => 
    m.role === "user" || m.role === "assistant" || m.role === "toolResult"
  ),

  // 可选: 干预消息获取
  getSteeringMessages: async () => {
    // 从某处获取用户中断消息
    return [];
  },

  // 可选: 跟进消息获取
  getFollowUpMessages: async () => [],

  // 可选: 动态 API 密钥
  getApiKey: async (provider) => "api-key",

  // 可选: 上下文变换
  transformContext: async (messages) => messages,
};

// 4. 启动循环
const stream = agentLoop(
  [{ role: "user", content: "用一下我的工具", timestamp: Date.now() }],
  context,
  config
);

// 5. 消费事件
for await (const event of stream) {
  switch (event.type) {
    case "agent_start":
      console.log("开始");
      break;
    case "turn_start":
      console.log("新轮次");
      break;
    case "message_start":
      console.log("消息:", event.message.role);
      break;
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
      if (event.assistantMessageEvent.type === "toolcall_end") {
        console.log("工具调用:", event.assistantMessageEvent.toolCall);
      }
      break;
    case "message_end":
      console.log("消息结束");
      break;
    case "tool_execution_start":
      console.log("执行工具:", event.toolName);
      break;
    case "tool_execution_end":
      console.log("工具完成:", event.result);
      break;
    case "turn_end":
      console.log("轮次结束");
      break;
    case "agent_end":
      console.log("完成:", event.messages);
      break;
  }
}

// 6. 获取结果
const result = await stream.result();
```

---

## 干预机制详解

```
用户消息 → LLM响应 → 工具A → 检查steering → 工具B → 检查steering → ... → LLM响应
                                          ↑
                                    如果有干预消息，跳过剩余工具
```

1. **工具执行后** 检查干预消息
2. **如果有干预**: 跳过剩余工具，将干预消息注入上下文
3. **如果没有**: 继续执行下一个工具或调用 LLM

跟进消息检查时机:
```
工具全部执行完毕 → 无更多工具调用 → 检查followUp → 有则继续，无则结束
```

---

## 何时使用 agent-loop vs Agent 类

### 使用 Agent 类 (推荐大多数场景)
```typescript
// 简单应用
const agent = new Agent({ initialState: {...}, convertToLlm: ... });
agent.subscribe(handler);
await agent.prompt("你好");
```

### 使用 agent-loop (需要更多控制)
```typescript
// 框架开发
// 需要手动管理状态
// 需要自定义消息队列
// 需要细粒度控制事件流
```

---

## 关键设计点

1. **无状态**: 所有状态通过参数传入，函数纯正
2. **双层循环**: 外层(跟进消息) + 内层(工具调用)
3. **消息转换边界**: AgentMessage → Message 仅在 LLM 调用时
4. **工具执行检查**: 每次工具执行后都检查干预消息
5. **事件驱动**: 每个生命周期阶段都发出事件
