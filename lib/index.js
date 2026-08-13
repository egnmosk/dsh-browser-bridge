// dsh-browser-bridge - DeepSeek Harness plugin entry.
//
// One host-plane row: registers the browser_* agent tools, provides a
// WebSocket upgrade route on the web server for the browser extension, and an
// HTTP /bridge/info route the extension's options page can auto-detect.
//
// Register in the profile's cordis.patch.yml:
//   - insert:
//       - id: browser-bridge
//         name: 'dsh-browser-bridge'

import { handleUpgrade } from "./ws.js";
import { BrowserBridge } from "./bridge.js";
import { registerTools } from "./tools.js";

const name = "browser-bridge";
const inject = ["webServer", "tools"];

function apply(ctx, config = {}) {
	const bridge = new BrowserBridge({
		timeoutMs: config.commandTimeoutMs ?? 60000,
		screenshotDir: config.screenshotDir,
		logger: ctx.logger,
	});
	const wsPath = config.path ?? "/bridge";
	let bridgeUrlHint = "";

	// The `tools` registry is a host service provided by the base layer; wait
	// for it (the root realm cannot access unprovided services synchronously).
	ctx.inject(["tools"], (toolsCtx) => {
		registerTools(toolsCtx, bridge, {
			commandTimeoutMs: config.commandTimeoutMs ?? 60000,
			bridgeUrlHint: () => bridgeUrlHint,
		});
	});

	// The extension's WebSocket endpoint, mounted on the DSH web server.
	ctx.inject(["webServer"], (webCtx) => {
		const dispose = webCtx.webServer.registerUpgrade({
			path: wsPath,
			handler: (req, socket, head) => {
				try {
					const conn = handleUpgrade(req, socket, head, { maxMessageBytes: config.maxMessageBytes ?? 8 * 1024 * 1024 });
					bridge.attach(conn);
				} catch (err) {
					webCtx.logger?.warn?.(`[browser-bridge] rejected upgrade: ${err?.message ?? err}`);
					socket.destroy();
				}
			},
		});
		webCtx.effect(() => dispose);
		const port = webCtx.webServer.port ?? "?";
		const host = webCtx.webServer.host ?? "127.0.0.1";
		bridgeUrlHint = `ws://${host}:${port}${wsPath}`;
		webCtx.logger?.info?.(`[browser-bridge] bridge ready - point the DSH Browser Bridge extension at ${bridgeUrlHint}`);
	});

	// Auto-detection endpoint for the extension's options page.
	ctx.inject(["webServer"], (webCtx) => {
		const dispose = webCtx.webServer.register({
			kind: "exact",
			path: `${wsPath}/info`,
			handler: async (req, res) => {
				const host = req.headers.host || `${webCtx.webServer.host ?? "127.0.0.1"}:${webCtx.webServer.port ?? "?"}`;
				const body = JSON.stringify({
					name: "dsh-browser-bridge",
					protocol: 1,
					ws: `ws://${host}${wsPath}`,
					connected: bridge.connected,
				});
				res.writeHead(200, {
					"content-type": "application/json; charset=utf-8",
					"access-control-allow-origin": "*",
					"cache-control": "no-store",
				});
				res.end(body);
			},
		});
		webCtx.effect(() => dispose);
	});

	ctx.effect(() => () => bridge.dispose());
}

export { apply, name, inject };
export default apply;
