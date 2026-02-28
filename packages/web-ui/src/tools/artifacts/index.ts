/**
 * @file artifacts/index.ts
 * @description 制品系统模块的 Barrel Export 入口。
 * 统一导出制品面板、制品元素、制品渲染器等公共 API。
 */

export { ArtifactElement } from "./ArtifactElement.js";
export { type Artifact, ArtifactsPanel, type ArtifactsParams } from "./artifacts.js";
export { ArtifactsToolRenderer } from "./artifacts-tool-renderer.js";
export { HtmlArtifact } from "./HtmlArtifact.js";
export { MarkdownArtifact } from "./MarkdownArtifact.js";
export { SvgArtifact } from "./SvgArtifact.js";
export { TextArtifact } from "./TextArtifact.js";
