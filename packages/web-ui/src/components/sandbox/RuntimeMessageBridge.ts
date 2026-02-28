/**
 * @file RuntimeMessageBridge.ts
 * @description 运行时消息桥代码生成器。
 * 为沙箱 iframe 和用户脚本上下文生成 sendRuntimeMessage() 函数的可注入代码，
 * 提供统一的消息 API，支持请求-响应和触发-遗忘两种模式。
 */

/** 消息类型：请求-响应 或 触发-遗忘 */
export type MessageType = "request-response" | "fire-and-forget";

/** 消息桥配置选项 */
export interface RuntimeMessageBridgeOptions {
	context: "sandbox-iframe" | "user-script";
	sandboxId: string;
}

// biome-ignore lint/complexity/noStaticOnlyClass: fine
export class RuntimeMessageBridge {
	/**
	 * Generate sendRuntimeMessage() function as injectable string.
	 * Returns the function source code to be injected into target context.
	 */
	static generateBridgeCode(options: RuntimeMessageBridgeOptions): string {
		if (options.context === "sandbox-iframe") {
			return RuntimeMessageBridge.generateSandboxBridge(options.sandboxId);
		} else {
			return RuntimeMessageBridge.generateUserScriptBridge(options.sandboxId);
		}
	}

	private static generateSandboxBridge(sandboxId: string): string {
		// Returns stringified function that uses window.parent.postMessage
		return `
window.__completionCallbacks = [];
window.sendRuntimeMessage = async (message) => {
    const messageId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);

    return new Promise((resolve, reject) => {
        const handler = (e) => {
            if (e.data.type === 'runtime-response' && e.data.messageId === messageId) {
                window.removeEventListener('message', handler);
                if (e.data.success) {
                    resolve(e.data);
                } else {
                    reject(new Error(e.data.error || 'Operation failed'));
                }
            }
        };

        window.addEventListener('message', handler);

        window.parent.postMessage({
            ...message,
            sandboxId: ${JSON.stringify(sandboxId)},
            messageId: messageId
        }, '*');

        // Timeout after 30s
        setTimeout(() => {
            window.removeEventListener('message', handler);
            reject(new Error('Runtime message timeout'));
        }, 30000);
    });
};
window.onCompleted = (callback) => {
    window.__completionCallbacks.push(callback);
};
`.trim();
	}

	private static generateUserScriptBridge(sandboxId: string): string {
		// Returns stringified function that uses chrome.runtime.sendMessage
		return `
window.__completionCallbacks = [];
window.sendRuntimeMessage = async (message) => {
    return await chrome.runtime.sendMessage({
        ...message,
        sandboxId: ${JSON.stringify(sandboxId)}
    });
};
window.onCompleted = (callback) => {
    window.__completionCallbacks.push(callback);
};
`.trim();
	}
}
