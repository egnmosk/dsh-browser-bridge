// Live end-to-end check: acts as the browser extension against the REAL dsh
// server (ws://127.0.0.1:3080/bridge), answers every request with canned data,
// and logs everything so the agent can verify the full chain.
// Run: node live-ext-test.mjs
import net from "node:net";
import crypto from "node:crypto";

const PORT = 3080;
const LOG = "C:/work/cmdfiles/dsh-browser-bridge/live-ext.log";
const fs = await import("node:fs");
fs.writeFileSync(LOG, "live extension starting\n");

function log(line) {
  fs.appendFileSync(LOG, new Date().toISOString() + " " + line + "\n");
}

const socket = net.connect(PORT, "127.0.0.1");
const key = crypto.randomBytes(16).toString("base64");
let buf = Buffer.alloc(0);
let handshaken = false;

function sendText(obj) {
  const p = Buffer.from(JSON.stringify(obj));
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(p);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  let header;
  if (p.length < 126) header = Buffer.from([0x81, 0x80 | p.length]);
  else if (p.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(p.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(p.length), 2);
  }
  socket.write(Buffer.concat([header, mask, masked]));
}

const CANNED = {
  status: { tabs: [{ id: 1, title: "DSH GUI", url: "http://127.0.0.1:3080", active: true }] },
  listTabs: { tabs: [
    { id: 1, title: "DSH GUI", url: "http://127.0.0.1:3080", active: true, windowId: 1, index: 0 },
    { id: 2, title: "Example", url: "https://example.com", active: false, windowId: 1, index: 1 },
  ] },
  activateTab: (args) => ({ tab: { id: args.tabId, title: "Example", url: "https://example.com", active: true, windowId: 1, index: 1 } }),
  navigate: (args) => ({ tab: { id: 2, title: "Example", url: args.url, active: false, windowId: 1, index: 1 } }),
  snapshot: { url: "https://example.com", title: "Example Domain", elements: [{ tag: "button", text: "More information", selector: "#more", role: "button" }], truncated: false },
  readPage: { url: "https://example.com", title: "Example Domain", text: "Example Domain - This domain is for use in illustrative examples.", truncated: false },
  click: { tag: "button", text: "More information" },
  type: {},
  press: {},
  scroll: { x: 0, y: 400 },
  wait: { found: true },
  eval: { result: { h1: "Example Domain" }, serialized: true },
};

socket.on("data", (chunk) => {
  buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
  if (!handshaken) {
    const idx = buf.indexOf("\r\n\r\n");
    if (idx === -1) return;
    buf = buf.subarray(idx + 4);
    handshaken = true;
    log("handshake 101 OK - sending hello");
    sendText({ type: "hello", protocol: 1, name: "dsh-browser-bridge-extension", version: "live-test" });
  }
  for (;;) {
    if (buf.length < 2) break;
    const b0 = buf[0], op = b0 & 0x0f, len = buf[1] & 0x7f;
    let off = 2, l = len;
    if (len === 126) { if (buf.length < 4) break; l = buf.readUInt16BE(2); off = 4; }
    if (buf.length < off + l) break;
    const payload = buf.subarray(off, off + l);
    buf = buf.subarray(off + l);
    if (op === 0x1) {
      const msg = JSON.parse(payload.toString());
      if (msg.type === "welcome") { log("WELCOME received: " + JSON.stringify(msg)); }
      else if (msg.type === "ping") { sendText({ type: "pong" }); }
      else if (msg.type === "request") {
        log("REQUEST " + msg.cmd + " args=" + JSON.stringify(msg.args));
        let value = CANNED[msg.cmd];
        if (typeof value === "function") value = value(msg.args || {});
        if (value !== undefined) {
          sendText({ type: "response", id: msg.id, ok: true, value });
          log("RESPONDED to " + msg.cmd);
        }
      }
    } else if (op === 0x8) { log("close frame"); socket.end(); }
  }
});
socket.on("connect", () => {
  socket.write("GET /bridge HTTP/1.1\r\nHost: 127.0.0.1:" + PORT + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n\r\n");
});
socket.on("error", (e) => log("socket error: " + e.message));
socket.on("close", () => { log("socket closed"); process.exit(0); });
setTimeout(() => { log("still alive after 60s"); }, 60000);
log("live extension client started, connecting to ws://127.0.0.1:" + PORT + "/bridge");
