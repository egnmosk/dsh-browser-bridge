// dsh-browser-bridge — minimal RFC 6455 WebSocket server over raw node:http sockets.
//
// The DSH host-webserver delivers upgraded sockets to route handlers without a
// WS library, so this module owns the handshake, frame encoding/decoding
// (client->server frames are masked, server->client frames are not), control
// frames (ping/pong/close), fragmentation, and a max-message guard. It has no
// dependencies beyond node: builtins.

import { createHash } from "node:crypto";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** One upgraded, speaking WebSocket connection. Single-slot listeners. */
export class WebSocketConnection {
	constructor(socket, options = {}) {
		this.socket = socket;
		this.maxMessageBytes = options.maxMessageBytes ?? 4 * 1024 * 1024;
		this._messageListener = null;
		this._closeListener = null;
		this._errorListener = null;
		this._buffer = Buffer.alloc(0);
		this._fragmentOpcode = 0;
		this._fragment = [];
		this._fragmentBytes = 0;
		this._closing = false;
		this._socketClosed = false;

		socket.on("data", (chunk) => this._onData(chunk));
		socket.on("error", (err) => {
			if (this._errorListener) this._errorListener(err);
			this._teardown();
		});
		socket.on("close", () => this._teardown());
	}

	onMessage(listener) {
		this._messageListener = listener;
	}
	onClose(listener) {
		this._closeListener = listener;
	}
	onError(listener) {
		this._errorListener = listener;
	}

	/** Send a text frame (unmasked, server -> client). */
	send(text) {
		if (this._closing || this._socketClosed) return false;
		const payload = Buffer.from(String(text), "utf8");
		this.socket.write(encodeFrame(OP_TEXT, payload));
		return true;
	}

	/** Send a close frame and destroy the socket once flushed. */
	close(code = 1000, reason = "") {
		if (this._closing || this._socketClosed) return;
		this._closing = true;
		try {
			const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
			payload.writeUInt16BE(code, 0);
			payload.write(reason, 2);
			this.socket.write(encodeFrame(OP_CLOSE, payload));
			this.socket.end();
		} catch {
			this.socket.destroy();
		}
	}

	_onData(chunk) {
		if (this._socketClosed) return;
		this._buffer = this._buffer.length === 0 ? chunk : Buffer.concat([this._buffer, chunk]);
		try {
			this._consume();
		} catch (err) {
			this.close(1002, "protocol error");
			if (this._errorListener) this._errorListener(err);
		}
	}

	_consume() {
		for (;;) {
			const buf = this._buffer;
			if (buf.length < 2) return;
			const b0 = buf[0];
			const b1 = buf[1];
			const fin = (b0 & 0x80) !== 0;
			const opcode = b0 & 0x0f;
			const masked = (b1 & 0x80) !== 0;
			let len = b1 & 0x7f;
			let offset = 2;
			if (len === 126) {
				if (buf.length < 4) return;
				len = buf.readUInt16BE(2);
				offset = 4;
			} else if (len === 127) {
				if (buf.length < 10) return;
				const big = buf.readBigUInt64BE(2);
				if (big > BigInt(this.maxMessageBytes)) throw new Error("frame too large");
				len = Number(big);
				offset = 10;
			}
			let maskKey = null;
			if (masked) {
				if (buf.length < offset + 4) return;
				maskKey = buf.subarray(offset, offset + 4);
				offset += 4;
			}
			if (len > this.maxMessageBytes) throw new Error("frame too large");
			if (buf.length < offset + len) return;

			let payload = buf.subarray(offset, offset + len);
			if (masked && maskKey) {
				payload = Buffer.from(payload);
				for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
			}
			this._buffer = buf.subarray(offset + len);

			if (opcode === OP_CLOSE) {
				let code = 1000;
				if (payload.length >= 2) code = payload.readUInt16BE(0);
				this.close(code === 1005 ? 1000 : code);
				return;
			}
			if (opcode === OP_PING) {
				this.socket.write(encodeFrame(OP_PONG, payload));
				continue;
			}
			if (opcode === OP_PONG) {
				continue;
			}
			if (opcode === OP_BINARY) {
				throw new Error("binary frames unsupported");
			}
			if (opcode === OP_TEXT) {
				if (!fin) {
					this._fragmentOpcode = OP_TEXT;
					this._fragment = [payload];
					this._fragmentBytes = payload.length;
				} else {
					this._deliver(payload);
				}
				continue;
			}
			if (opcode === 0x0) {
				if (this._fragmentOpcode === 0) throw new Error("unexpected continuation frame");
				this._fragment.push(payload);
				this._fragmentBytes += payload.length;
				if (this._fragmentBytes > this.maxMessageBytes) throw new Error("message too large");
				if (fin) {
					const message = Buffer.concat(this._fragment, this._fragmentBytes);
					this._fragmentOpcode = 0;
					this._fragment = [];
					this._fragmentBytes = 0;
					this._deliver(message);
				}
				continue;
			}
			// Unknown/RSV opcodes.
			throw new Error(`unsupported opcode ${opcode}`);
		}
	}

	_deliver(payload) {
		const text = payload.toString("utf8");
		if (this._messageListener) {
			try {
				this._messageListener(text);
			} catch (err) {
				if (this._errorListener) this._errorListener(err);
			}
		}
	}

	_teardown() {
		if (this._socketClosed) return;
		this._socketClosed = true;
		if (this._closeListener) this._closeListener();
	}
}

/**
 * Perform the RFC 6455 opening handshake on an upgraded socket.
 * @param req - the node:http upgrade request (headers on `req.headers`).
 * @param socket - the raw TCP socket.
 * @param head - any bytes already buffered past the request headers.
 * @returns the live WebSocketConnection, or throws when the handshake is invalid.
 */
export function handleUpgrade(req, socket, head, options = {}) {
	const headers = req.headers;
	const upgrade = String(headers.upgrade ?? "").toLowerCase();
	const connection = String(headers.connection ?? "").toLowerCase();
	if (upgrade !== "websocket" || !connection.includes("upgrade")) {
		throw new Error("not a websocket upgrade");
	}
	const key = headers["sec-websocket-key"];
	if (!key) throw new Error("missing sec-websocket-key");
	const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
	socket.write(
		"HTTP/1.1 101 Switching Protocols\r\n" +
			"Upgrade: websocket\r\n" +
			"Connection: Upgrade\r\n" +
			`Sec-WebSocket-Accept: ${accept}\r\n` +
			"\r\n"
	);
	const conn = new WebSocketConnection(socket, options);
	if (head && head.length > 0) conn._onData(head);
	return conn;
}

/** Encode one server->client frame (unmasked). */
export function encodeFrame(opcode, payload) {
	const len = payload.length;
	let header;
	if (len < 126) {
		header = Buffer.from([0x80 | opcode, len]);
	} else if (len < 65536) {
		header = Buffer.alloc(4);
		header[0] = 0x80 | opcode;
		header[1] = 126;
		header.writeUInt16BE(len, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x80 | opcode;
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(len), 2);
	}
	return Buffer.concat([header, payload]);
}

/** Encode one client->server frame (masked) — used by the test harness client. */
export function encodeClientFrame(opcode, payload, maskKey = randomMask()) {
	const len = payload.length;
	let header;
	if (len < 126) {
		header = Buffer.from([0x80 | opcode, 0x80 | len]);
	} else if (len < 65536) {
		header = Buffer.alloc(4);
		header[0] = 0x80 | opcode;
		header[1] = 0x80 | 126;
		header.writeUInt16BE(len, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x80 | opcode;
		header[1] = 0x80 | 127;
		header.writeBigUInt64BE(BigInt(len), 2);
	}
	const masked = Buffer.from(payload);
	for (let i = 0; i < masked.length; i++) masked[i] ^= maskKey[i & 3];
	return Buffer.concat([header, maskKey, masked]);
}

function randomMask() {
	const buf = Buffer.alloc(4);
	for (let i = 0; i < 4; i++) buf[i] = Math.floor(Math.random() * 256);
	return buf;
}
