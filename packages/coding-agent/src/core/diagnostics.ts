/**
 * 资源诊断和冲突检测类型模块
 *
 * 职责：
 * - 定义资源冲突类型（扩展、技能、提示词、主题的名称碰撞）
 * - 定义资源诊断消息类型（警告、错误、冲突）
 */

/** 资源冲突 - 两个资源具有相同名称 */
export interface ResourceCollision {
	resourceType: "extension" | "skill" | "prompt" | "theme";
	name: string; // skill name, command/tool/flag name, prompt name, theme name
	winnerPath: string;
	loserPath: string;
	winnerSource?: string; // e.g., "npm:foo", "git:...", "local"
	loserSource?: string;
}

/** 资源诊断消息 */
export interface ResourceDiagnostic {
	type: "warning" | "error" | "collision";
	message: string;
	path?: string;
	collision?: ResourceCollision;
}
