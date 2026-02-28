/**
 * @file TypeBox 辅助工具
 *
 * 提供与 TypeBox JSON Schema 库配合使用的辅助类型和函数。
 * 主要解决 Google API 等提供商不支持 anyOf/const 模式的兼容性问题。
 */

import { type TUnsafe, Type } from "@sinclair/typebox";

/**
 * 创建兼容 Google API 及其他不支持 anyOf/const 模式的提供商的字符串枚举 Schema。
 * 使用标准的 JSON Schema enum 格式而非 TypeBox 默认的 anyOf/const 格式。
 *
 * @example
 * const OperationSchema = StringEnum(["add", "subtract", "multiply", "divide"], {
 *   description: "The operation to perform"
 * });
 *
 * type Operation = Static<typeof OperationSchema>; // "add" | "subtract" | "multiply" | "divide"
 */
export function StringEnum<T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: values as any,
		...(options?.description && { description: options.description }),
		...(options?.default && { default: options.default }),
	});
}
