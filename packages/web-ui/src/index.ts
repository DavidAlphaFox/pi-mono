/**
 * @file index.ts
 * @description Web UI 组件库的主入口文件（Barrel Export）。
 * 统一导出所有公共 API，包括组件、对话框、工具、存储、工具提示词和工具函数。
 * 使用 mini-lit Web Components 构建 AI 聊天界面。
 */

// ============================================================================
// 核心类型和顶层组件
// ============================================================================
export type { Agent, AgentMessage, AgentState, ThinkingLevel } from "@mariozechner/pi-agent-core";
export type { Model } from "@mariozechner/pi-ai";
export { ChatPanel } from "./ChatPanel.js";

// ============================================================================
// UI 组件
// ============================================================================
export { AgentInterface } from "./components/AgentInterface.js";
export { AttachmentTile } from "./components/AttachmentTile.js";
export { ConsoleBlock } from "./components/ConsoleBlock.js";
export { CustomProviderCard } from "./components/CustomProviderCard.js";
export { ExpandableSection } from "./components/ExpandableSection.js";
export { Input } from "./components/Input.js";
export { MessageEditor } from "./components/MessageEditor.js";
export { MessageList } from "./components/MessageList.js";

// 消息组件及类型
export type { ArtifactMessage, UserMessageWithAttachments } from "./components/Messages.js";
export {
	AbortedMessage,
	AssistantMessage,
	convertAttachments,
	defaultConvertToLlm,
	isArtifactMessage,
	isUserMessageWithAttachments,
	ToolMessage,
	ToolMessageDebugView,
	UserMessage,
} from "./components/Messages.js";
// 消息渲染器注册表
export {
	getMessageRenderer,
	type MessageRenderer,
	type MessageRole,
	registerMessageRenderer,
	renderMessage,
} from "./components/message-renderer-registry.js";
export { ProviderKeyInput } from "./components/ProviderKeyInput.js";
export {
	type SandboxFile,
	SandboxIframe,
	type SandboxResult,
	type SandboxUrlProvider,
} from "./components/SandboxedIframe.js";
export { StreamingMessageContainer } from "./components/StreamingMessageContainer.js";
// 沙箱运行时提供者（Sandbox Runtime Providers）
export { ArtifactsRuntimeProvider } from "./components/sandbox/ArtifactsRuntimeProvider.js";
export { AttachmentsRuntimeProvider } from "./components/sandbox/AttachmentsRuntimeProvider.js";
export { type ConsoleLog, ConsoleRuntimeProvider } from "./components/sandbox/ConsoleRuntimeProvider.js";
export {
	type DownloadableFile,
	FileDownloadRuntimeProvider,
} from "./components/sandbox/FileDownloadRuntimeProvider.js";
export { RuntimeMessageBridge } from "./components/sandbox/RuntimeMessageBridge.js";
export { RUNTIME_MESSAGE_ROUTER } from "./components/sandbox/RuntimeMessageRouter.js";
export type { SandboxRuntimeProvider } from "./components/sandbox/SandboxRuntimeProvider.js";
export { ThinkingBlock } from "./components/ThinkingBlock.js";
export { ApiKeyPromptDialog } from "./dialogs/ApiKeyPromptDialog.js";
export { AttachmentOverlay } from "./dialogs/AttachmentOverlay.js";
// 对话框组件
export { ModelSelector } from "./dialogs/ModelSelector.js";
export { PersistentStorageDialog } from "./dialogs/PersistentStorageDialog.js";
export { ProvidersModelsTab } from "./dialogs/ProvidersModelsTab.js";
export { SessionListDialog } from "./dialogs/SessionListDialog.js";
export { ApiKeysTab, ProxyTab, SettingsDialog, SettingsTab } from "./dialogs/SettingsDialog.js";
// 工具提示词模板
export {
	ARTIFACTS_RUNTIME_PROVIDER_DESCRIPTION_RO,
	ARTIFACTS_RUNTIME_PROVIDER_DESCRIPTION_RW,
	ATTACHMENTS_RUNTIME_DESCRIPTION,
} from "./prompts/prompts.js";
// 存储层（Storage）
export { AppStorage, getAppStorage, setAppStorage } from "./storage/app-storage.js";
export { IndexedDBStorageBackend } from "./storage/backends/indexeddb-storage-backend.js";
export { Store } from "./storage/store.js";
export type {
	AutoDiscoveryProviderType,
	CustomProvider,
	CustomProviderType,
} from "./storage/stores/custom-providers-store.js";
export { CustomProvidersStore } from "./storage/stores/custom-providers-store.js";
export { ProviderKeysStore } from "./storage/stores/provider-keys-store.js";
export { SessionsStore } from "./storage/stores/sessions-store.js";
export { SettingsStore } from "./storage/stores/settings-store.js";
export type {
	IndexConfig,
	IndexedDBConfig,
	SessionData,
	SessionMetadata,
	StorageBackend,
	StorageTransaction,
	StoreConfig,
} from "./storage/types.js";
// 制品系统（Artifacts）
export { ArtifactElement } from "./tools/artifacts/ArtifactElement.js";
export { ArtifactPill } from "./tools/artifacts/ArtifactPill.js";
export { type Artifact, ArtifactsPanel, type ArtifactsParams } from "./tools/artifacts/artifacts.js";
export { ArtifactsToolRenderer } from "./tools/artifacts/artifacts-tool-renderer.js";
export { HtmlArtifact } from "./tools/artifacts/HtmlArtifact.js";
export { ImageArtifact } from "./tools/artifacts/ImageArtifact.js";
export { MarkdownArtifact } from "./tools/artifacts/MarkdownArtifact.js";
export { SvgArtifact } from "./tools/artifacts/SvgArtifact.js";
export { TextArtifact } from "./tools/artifacts/TextArtifact.js";
export { createExtractDocumentTool, extractDocumentTool } from "./tools/extract-document.js";
// 工具系统
export { getToolRenderer, registerToolRenderer, renderTool, setShowJsonMode } from "./tools/index.js";
export { createJavaScriptReplTool, javascriptReplTool } from "./tools/javascript-repl.js";
export { renderCollapsibleHeader, renderHeader } from "./tools/renderer-registry.js";
export { BashRenderer } from "./tools/renderers/BashRenderer.js";
export { CalculateRenderer } from "./tools/renderers/CalculateRenderer.js";
// 工具渲染器
export { DefaultRenderer } from "./tools/renderers/DefaultRenderer.js";
export { GetCurrentTimeRenderer } from "./tools/renderers/GetCurrentTimeRenderer.js";
export type { ToolRenderer, ToolRenderResult } from "./tools/types.js";
export type { Attachment } from "./utils/attachment-utils.js";
// 工具函数
export { loadAttachment } from "./utils/attachment-utils.js";
export { clearAuthToken, getAuthToken } from "./utils/auth-token.js";
export { formatCost, formatModelCost, formatTokenCount, formatUsage } from "./utils/format.js";
export { i18n, setLanguage, translations } from "./utils/i18n.js";
export { applyProxyIfNeeded, createStreamFn, isCorsError, shouldUseProxyForProvider } from "./utils/proxy-utils.js";
