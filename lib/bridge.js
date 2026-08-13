// dsh-browser-bridge - the bridge service: one WebSocket client (the browser
// extension), request/response correlation for agent tool calls, timeouts,
// liveness pings, and screenshot persistence.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PING_INTERVAL_MS = 15000;

/** Structured bridge failure the tools surface to the model. */
export class BridgeError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "BridgeError";
		this.code = code;
	}
}

function defaultScreenshotDir() {
	const home = process.env.DSH_HOME || join(homedir(), ".dsh");
	return join(home, "browser-bridge");
}

export class BrowserBridge {
	constructor(options = {}) {
		this.timeoutMs = options.timeoutMs ?? 60000;
		this.screenshotDir = options.screenshotDir || defaultScreenshotDir();
		this.logger = options.logger ?? null;

		/** The one current extension connection (latest wins). */
		this.client = null;
		this.extensionInfo = null;
		/** id -> { resolve, reject } */
		this.pending = new Map();
		this.seq = 0;
		this._pingTimer = null;

		try {
			mkdirSync(this.screenshotDir, { recursive: true });
		} catch (err) {
			if (this.logger) this.logger.warn?.(`[browser-bridge] cannot create screenshot dir: ${err.message}`);
		}
	}

	get connected() {
		return this.client !== null;
	}

	/** The URL clients should connect to, printed once at startup. */
	get info() {
		return this.extensionInfo;
	}

	attach(conn) {
		if (this.client && this.client !== conn) {
			try {
				this.client.close(4000, "replaced by a newer connection");
			} catch {
				/* socket already gone */
			}
		}
		this.client = conn;
		this.extensionInfo = null;
		conn.onMessage((text) => this._onMessage(text));
		conn.onClose(() => {
			if (this.client === conn) {
				this.client = null;
				this.extensionInfo = null;
				this._failAll(new BridgeError("DISCONNECTED", "The browser extension disconnected while a command was in flight."));
			}
		});
		conn.onError((err) => {
			if (this.logger) this.logger.warn?.(`[browser-bridge] connection error: ${err?.message ?? err}`);
		});
		this._startPing();
		if (this.logger) this.logger.info?.("[browser-bridge] browser extension connected");
	}

	/**
	 * Send one command to the extension and await its response.
	 * @param cmd - extension protocol command name (camelCase).
	 * @param args - command arguments object.
	 * @param options - { timeoutMs, signal } overrides.
	 * @returns the extension's `value`.
	 */
	request(cmd, args = {}, options = {}) {
		const client = this.client;
		if (!client) {
			return Promise.reject(
				new BridgeError(
					"NOT_CONNECTED",
					"The browser is not connected. Open the DSH Browser Bridge extension in your browser and make sure its popup shows a connected state, then retry."
				)
			);
		}
		const id = "r" + ++this.seq;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new BridgeError("TIMEOUT", `The browser did not answer "${cmd}" within ${Math.round((options.timeoutMs ?? this.timeoutMs) / 1000)}s. The extension may be asleep or the page may be busy; retry.`));
			}, options.timeoutMs ?? this.timeoutMs);
			const settle = (fn, value) => {
				clearTimeout(timer);
				this.pending.delete(id);
				fn(value);
			};
			this.pending.set(id, {
				resolve: (value) => settle(resolve, value),
				reject: (err) => settle(reject, err),
			});
			if (options.signal) {
				if (options.signal.aborted) {
					clearTimeout(timer);
					this.pending.delete(id);
					reject(new BridgeError("ABORTED", "The browser command was aborted."));
					return;
				}
				options.signal.addEventListener(
					"abort",
					() => {
						if (this.pending.has(id)) {
							clearTimeout(timer);
							this.pending.delete(id);
							reject(new BridgeError("ABORTED", "The browser command was aborted."));
						}
					},
					{ once: true }
				);
			}
			try {
				client.send(JSON.stringify({ type: "request", id, cmd, args }));
			} catch (err) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(new BridgeError("SEND_FAILED", `Failed to send command to the browser: ${err.message}`));
			}
		});
	}

	/** Persist a data:image/... URL to a PNG/JPEG file; returns the file path. */
	saveScreenshot(dataUrl) {
		const match = /^data:image\/(png|jpeg);base64,(.+)$/.exec(String(dataUrl || ""));
		if (!match) throw new BridgeError("BAD_SCREENSHOT", "The extension returned an invalid screenshot payload.");
		const [, kind, base64] = match;
		const buf = Buffer.from(base64, "base64");
		const ext = kind === "jpeg" ? "jpg" : "png";
		const file = join(this.screenshotDir, `screenshot-${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
		writeFileSync(file, buf);
		return file;
	}

	status() {
		return {
			connected: this.connected,
			extension: this.extensionInfo,
			pending: this.pending.size,
		};
	}

	_onMessage(text) {
		let msg;
		try {
			msg = JSON.parse(text);
		} catch {
			return;
		}
		if (!msg || typeof msg !== "object") return;
		switch (msg.type) {
			case "hello":
				this.extensionInfo = { name: msg.name ?? "unknown", version: msg.version ?? "?" };
				this.client?.send(JSON.stringify({ type: "welcome", protocol: 1, server: "dsh-browser-bridge", version: "0.1.0" }));
				break;
			case "pong":
				break;
			case "response": {
				const entry = msg.id ? this.pending.get(msg.id) : null;
				if (!entry) break;
				this.pending.delete(msg.id);
				if (msg.ok) entry.resolve(msg.value ?? {});
				else entry.reject(new BridgeError("EXTENSION", String(msg.error ?? "the browser extension reported an error")));
				break;
			}
			default:
				break;
		}
	}

	_startPing() {
		this._stopPing();
		this._pingTimer = setInterval(() => {
			if (this.client) {
				try {
					this.client.send(JSON.stringify({ type: "ping" }));
				} catch {
					/* socket is dying; close handler will clean up */
				}
			}
		}, PING_INTERVAL_MS);
		if (this._pingTimer.unref) this._pingTimer.unref();
	}

	_stopPing() {
		if (this._pingTimer) {
			clearInterval(this._pingTimer);
			this._pingTimer = null;
		}
	}

	_failAll(error) {
		for (const [, entry] of this.pending) entry.reject(error);
		this.pending.clear();
	}

	dispose() {
		this._stopPing();
		this._failAll(new BridgeError("SHUTDOWN", "The bridge is shutting down."));
		if (this.client) {
			try {
				this.client.close(1001, "server shutting down");
			} catch {
				/* ignore */
			}
			this.client = null;
		}
	}
}
