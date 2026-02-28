/**
 * @file PKCE（Proof Key for Code Exchange）工具
 *
 * 使用 Web Crypto API 实现 PKCE 授权码交换安全扩展。
 * 兼容 Node.js 20+ 和浏览器环境。
 * PKCE 通过生成随机验证码和 SHA-256 挑战码，防止授权码拦截攻击。
 */

/** 将字节数组编码为 base64url 字符串（URL 安全的 Base64 变体） */
function base64urlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/** 生成 PKCE 验证码和挑战码。验证码是 32 字节的随机值，挑战码是其 SHA-256 哈希 */
export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
	// Generate random verifier
	const verifierBytes = new Uint8Array(32);
	crypto.getRandomValues(verifierBytes);
	const verifier = base64urlEncode(verifierBytes);

	// Compute SHA-256 challenge
	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const challenge = base64urlEncode(new Uint8Array(hashBuffer));

	return { verifier, challenge };
}
