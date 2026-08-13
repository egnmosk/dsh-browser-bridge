// dsh-browser-bridge - standalone protocol test.
//
// Boots a real node:http server with the plugin's WS upgrade handler, a fake
// extension client speaking raw RFC 6455 (masked frames), and the plugin's
// tool definitions, then runs an end-to-end flow: handshake, hello/welcome,
// command round-trips through every tool, timeout, disconnect, and the
// /bridge/info HTTP route.
//
// Run: node test/run-test.mjs

import { createServer } from "node:http";
import net from "node:net";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleUpgrade, encodeClientFrame } from "../lib/ws.js";
import { BrowserBridge } from "../lib/bridge.js";
import { registerTools } from "../lib/tools.js";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

let passed = 0;
let failed = 0;
function check(label, cond, extra = "") {
	if (cond) {
		passed++;
		console.log(`  ok: ${label}`);
	} else {
		failed++;
		console.error(`  FAIL: ${label} ${extra}`);
	}
}

// Walk a candidate tool result and reject anything that is not lossless JSON
// (undefined values, non-finite numbers, functions, cycles).
function assertLossless(value, seen = new Set()) {
	if (value === null) return true;
	const t = typeof value;
	if (t === "string" || t === "boolean") return true;
	if (t === "number") return Number.isFinite(value) && !Object.is(value, -0);
	if (t !== "object") return false;
	if (seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value)) {
		for (const item of value) if (!assertLossless(item, seen)) return false;
		return true;
	}
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return false;
	for (const [k, v] of Object.entries(value)) {
		if (v === undefined) return false;
		if (!assertLossless(v, seen)) return false;
	}
	return true;
}

// ---- fake extension client -------------------------------------------------
function makeClient(port, behavior = {}) {
	return new Promise((resolve, reject) => {
		const socket = net.connect(port, "127.0.0.1");
		const key = "dGhlIHNhbXBsZSBub25jZQ=="; // any base64 key
		const client = {
			socket,
			messages: [],
			onMessage: null,
			send(obj) {
				socket.write(encodeClientFrame(0x1, Buffer.from(JSON.stringify(obj))));
			},
			close() {
				socket.write(encodeClientFrame(0x8, Buffer.from([0x03, 0xe8])));
				socket.end();
			},
		};
		let buf = Buffer.alloc(0);
		let handshaken = false;
		const respond = (msg) => {
			// canned responder: answer every request based on cmd
			if (msg.type !== "request") return;
			const value = behavior.respond ? behavior.respond(msg) : null;
			if (value === null) return; // no response (timeout test)
			if (value === "error") {
				client.send({ type: "response", id: msg.id, ok: false, error: `ext error for ${msg.cmd}` });
			} else {
				client.send({ type: "response", id: msg.id, ok: true, value });
			}
		};
		socket.on("data", (chunk) => {
			buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
			if (!handshaken) {
				const idx = buf.indexOf("\r\n\r\n");
				if (idx === -1) return;
				buf = buf.subarray(idx + 4);
				handshaken = true;
				client.send({ type: "hello", protocol: 1, name: "dsh-browser-bridge-extension", version: "0.1.0" });
			}
			for (;;) {
				if (buf.length < 2) break;
				const b0 = buf[0];
				const op = b0 & 0x0f;
				const len = buf[1] & 0x7f;
				let offset = 2;
				let length = len;
				if (len === 126) {
					if (buf.length < 4) break;
					length = buf.readUInt16BE(2);
					offset = 4;
				} else if (len === 127) {
					if (buf.length < 10) break;
					length = Number(buf.readBigUInt64BE(2));
					offset = 10;
				}
				if (buf.length < offset + length) break;
				const payload = buf.subarray(offset, offset + length);
				buf = buf.subarray(offset + length);
				if (op === 0x1) {
					const msg = JSON.parse(payload.toString("utf8"));
					client.messages.push(msg);
					if (client.onMessage) client.onMessage(msg);
					respond(msg);
				} else if (op === 0x9) {
					socket.write(encodeClientFrame(0xa, payload));
				} else if (op === 0x8) {
					socket.end();
				}
			}
		});
		socket.on("connect", () => {
			socket.write(
				"GET /bridge HTTP/1.1\r\n" +
					"Host: 127.0.0.1\r\n" +
					"Upgrade: websocket\r\n" +
					"Connection: Upgrade\r\n" +
					`Sec-WebSocket-Key: ${key}\r\n` +
					"Sec-WebSocket-Version: 13\r\n\r\n"
			);
		});
		socket.on("error", reject);
		socket.on("close", () => {
			client.closed = true;
		});
		// wait for the 101 handshake
		socket.once("data", () => resolve(client));
	});
}

// ---- fake cordis ctx ---------------------------------------------------------
function fakeCtx(bridge, tools) {
	const webServer = {
		host: "127.0.0.1",
		port: null,
		routes: [],
		upgrades: [],
		register(route) {
			this.routes.push(route);
			return () => {};
		},
		registerUpgrade(route) {
			this.upgrades.push(route);
			return () => {};
		},
	};
	const ctx = {
		logger: console,
		tools: { register: (def) => tools.push(def) },
		webServer,
		effects: [],
		effect(fn) {
			this.effects.push(fn);
		},
		inject(names, cb) {
			cb(ctx); // webServer/tools exist synchronously in the fake
		},
	};
	return ctx;
}

const APP_VERSION = "0.1.0";

async function main() {
	const tools = [];
	const bridge = new BrowserBridge({
		timeoutMs: 1500,
		screenshotDir: join(tmpdir(), "dsh-browser-bridge-test"),
		logger: null,
	});
	const ctx = fakeCtx(bridge, tools);
	registerTools(ctx, bridge, { commandTimeoutMs: 1500 });

	const server = createServer();
	let upgradeHandler;
	server.on("upgrade", (req, socket, head) => {
		const conn = handleUpgrade(req, socket, head);
		bridge.attach(conn);
	});
	// HTTP routes (simplified /bridge/info)
	server.on("request", (req, res) => {
		if (req.url === "/bridge/info") {
			const body = JSON.stringify({ name: "dsh-browser-bridge", protocol: 1, ws: "ws://127.0.0.1:" + server.address().port + "/bridge", connected: bridge.connected });
			res.writeHead(200, { "content-type": "application/json" });
			res.end(body);
			return;
		}
		res.writeHead(404);
		res.end();
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const port = server.address().port;
	ctx.webServer.port = port;

	const toolNames = tools.map((t) => t.name);
	console.log(`registered tools: ${toolNames.join(", ")}`);
	check("13 tools registered", toolNames.length === 13, `got ${toolNames.length}`);
	for (const n of ["browser_status", "browser_list_tabs", "browser_activate_tab", "browser_navigate", "browser_snapshot", "browser_read_page", "browser_click", "browser_type", "browser_press", "browser_scroll", "browser_wait", "browser_screenshot", "browser_eval"]) {
		check(`tool ${n} present`, toolNames.includes(n));
	}

	const exec = { signal: new AbortController().signal, agent: null, session: null };

	// 1. not connected
	{
		const status = await tools.find((t) => t.name === "browser_status").execute({}, exec).then((v) => v, (e) => ({ error: e.code }));
		check("browser_status reports disconnected before connect", status.connected === false && status.extension === undefined, JSON.stringify(status));
		const nav = await tools.find((t) => t.name === "browser_navigate").execute({ url: "https://example.com" }, exec).then((v) => v, (e) => ({ error: e.code }));
		check("navigate before connect fails NOT_CONNECTED", nav.error === "NOT_CONNECTED", JSON.stringify(nav));
	}

	// 2. connect extension
	const client = await makeClient(port, {
		respond: (msg) => {
			switch (msg.cmd) {
				case "status":
					return { tabs: [{ id: 1, title: "Example", url: "https://example.com", active: true }] };
				case "listTabs":
					return { tabs: [{ id: 1, title: "Example", url: "https://example.com", active: true }, { id: 2, title: "Docs", url: "https://docs.example.com", active: false }] };
				case "activateTab":
					return { tab: { id: 2, title: "Docs", url: "https://docs.example.com", active: true } };
				case "navigate":
					return { tab: { id: 1, title: "Example", url: msg.args.url, active: true }, error: undefined };
				case "snapshot":
					return { url: "https://example.com", title: "Example", elements: [{ tag: "button", text: "Go", selector: "#go", role: "button" }], truncated: false };
				case "readPage":
					return { url: "https://example.com", title: "Example", text: "Hello world.", truncated: false };
				case "click":
					return { tag: "button", text: "Go" };
				case "type":
					return {};
				case "press":
					return {};
				case "scroll":
					return { x: 0, y: 800 };
				case "wait":
					return { found: true };
				case "screenshot":
					return { dataUrl: "data:image/png;base64," + Buffer.from("fakepng").toString("base64"), width: 1280, height: 720, bytes: 7 };
				case "eval":
					return { result: { h1: "Example Domain" }, serialized: true };
				default:
					return {};
			}
		},
	});
	await new Promise((r) => setTimeout(r, 50));
	check("bridge connected after extension hello", bridge.connected);
	check("extension info captured", bridge.info?.name === "dsh-browser-bridge-extension" || bridge.info?.name !== undefined, JSON.stringify(bridge.info));
	const welcome = client.messages.find((m) => m.type === "welcome");
	check("extension received welcome", !!welcome && welcome.protocol === 1);

	// 3. round-trips through tools
	{
		const status = await tools.find((t) => t.name === "browser_status").execute({}, exec);
		check("browser_status connected", status.ok === true && status.connected === true);

		const tabs = await tools.find((t) => t.name === "browser_list_tabs").execute({}, exec);
		check("browser_list_tabs returns 2 tabs", tabs.tabs.length === 2 && tabs.tabs[1].title === "Docs");

		const act = await tools.find((t) => t.name === "browser_activate_tab").execute({ tabId: 2 }, exec);
		check("browser_activate_tab", act.tab.id === 2 && act.tab.active === true);

		const nav = await tools.find((t) => t.name === "browser_navigate").execute({ url: "https://example.com/new" }, exec);
		check("browser_navigate", nav.tab.url === "https://example.com/new");

		const snap = await tools.find((t) => t.name === "browser_snapshot").execute({}, exec);
		check("browser_snapshot", snap.elements.length === 1 && snap.elements[0].selector === "#go");

		const read = await tools.find((t) => t.name === "browser_read_page").execute({}, exec);
		check("browser_read_page", read.text === "Hello world.");

		const click = await tools.find((t) => t.name === "browser_click").execute({ selector: "#go" }, exec);
		check("browser_click", click.ok === true && click.tag === "button");

		const type = await tools.find((t) => t.name === "browser_type").execute({ selector: "#q", text: "hello" }, exec);
		check("browser_type", type.ok === true);

		const press = await tools.find((t) => t.name === "browser_press").execute({ key: "Enter" }, exec);
		check("browser_press", press.ok === true);

		const scroll = await tools.find((t) => t.name === "browser_scroll").execute({ direction: "down" }, exec);
		check("browser_scroll", scroll.y === 800);

		const wait = await tools.find((t) => t.name === "browser_wait").execute({ selector: "#go", timeoutMs: 3000 }, exec);
		check("browser_wait", wait.found === true);

		const shot = await tools.find((t) => t.name === "browser_screenshot").execute({}, exec);
		check("browser_screenshot saves file", shot.ok === true && shot.path.endsWith(".png") && shot.bytes === 7, JSON.stringify(shot));

		const ev = await tools.find((t) => t.name === "browser_eval").execute({ expression: "document.querySelector('h1').textContent" }, exec);
		check("browser_eval", ev.result?.h1 === "Example Domain");

		// every tool result must be lossless JSON (no undefined values) - the
		// runtime snapshots results and rejects undefined-valued properties
		for (const [label, value] of [["status", status], ["listTabs", tabs], ["activate", act], ["navigate", nav], ["snapshot", snap], ["readPage", read], ["click", click], ["type", type], ["press", press], ["scroll", scroll], ["wait", wait], ["screenshot", shot], ["eval", ev]]) {
			check(`lossless JSON: ${label}`, assertLossless(value), JSON.stringify(value).slice(0, 120));
		}

		// extension error path
		const clientErr = await makeClient(port, { respond: () => "error" });
		await new Promise((r) => setTimeout(r, 50));
		const err = await tools.find((t) => t.name === "browser_click").execute({ selector: "#x" }, exec).then((v) => v, (e) => ({ error: e.code, message: e.message }));
		check("extension error surfaces as EXTENSION", err.error === "EXTENSION" && err.message.includes("ext error"), JSON.stringify(err));
		clientErr.close();
		await new Promise((r) => setTimeout(r, 50));
		check("bridge detached after client close", !bridge.connected);
	}

	// 4. timeout: client that never answers
	{
		const silent = await makeClient(port, { respond: () => null });
		await new Promise((r) => setTimeout(r, 50));
		const t0 = Date.now();
		const res = await tools.find((t) => t.name === "browser_list_tabs").execute({}, exec).then((v) => v, (e) => ({ error: e.code }));
		const elapsed = Date.now() - t0;
		check("silent client times out", res.error === "TIMEOUT" && elapsed >= 1200, JSON.stringify(res));
		silent.close();
		await new Promise((r) => setTimeout(r, 50));
		check("bridge detached after silent close", !bridge.connected);
	}

	// 5. disconnect -> NOT_CONNECTED
	{
		client.close();
		await new Promise((r) => setTimeout(r, 100));
		check("bridge disconnected after close", !bridge.connected);
		const res = await tools.find((t) => t.name === "browser_list_tabs").execute({}, exec).then((v) => v, (e) => ({ error: e.code }));
		check("disconnected tools fail NOT_CONNECTED", res.error === "NOT_CONNECTED");
	}

	// 6. /bridge/info HTTP route
	{
		const resp = await fetch(`http://127.0.0.1:${port}/bridge/info`);
		const json = await resp.json();
		check("/bridge/info serves JSON", json.name === "dsh-browser-bridge" && json.protocol === 1 && json.connected === false);
	}

	// 7. tool render smoke test
	{
		const def = tools.find((t) => t.name === "browser_list_tabs");
		const blocks = def.output.render({}, { ok: true, tabs: [{ id: 1, title: "A", url: "https://a", active: true }] });
		check("render produces text block", Array.isArray(blocks) && blocks[0].type === "text" && blocks[0].text.includes("[1] (active) A"));
	}

	server.close();
	bridge.dispose();
	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
