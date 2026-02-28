/**
 * @file HTTP 代理设置
 *
 * 根据环境变量（HTTP_PROXY、HTTPS_PROXY）为 Node.js 的 fetch() 设置 HTTP 代理。
 * Bun 内置支持代理，无需额外配置。
 *
 * 使用 undici 的 EnvHttpProxyAgent 实现全局代理分发。
 * ES 模块有缓存机制，多次导入是安全的——设置只会执行一次。
 * 需要代理支持的代码应尽早导入此模块。
 */
if (typeof process !== "undefined" && process.versions?.node) {
	import("undici").then((m) => {
		const { EnvHttpProxyAgent, setGlobalDispatcher } = m;
		setGlobalDispatcher(new EnvHttpProxyAgent());
	});
}
