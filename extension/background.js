// DSH Browser Bridge — background service worker (MV3).
//
// Maintains the WebSocket connection to the DeepSeek Harness bridge server,
// reconnects with backoff, and executes commands from the server against the
// browser: tab management via chrome.tabs, page actions via the content script
// (chrome.tabs.sendMessage), screenshots via chrome.tabs.captureVisibleTab.

const DEFAULTS = {
  bridgeUrl: "ws://127.0.0.1:3080/bridge",
  autoConnect: true,
};

const PROTOCOL = 1;
const EXT_NAME = "dsh-browser-bridge-extension";
const EXT_VERSION = chrome.runtime.getManifest().version;

let config = { ...DEFAULTS };
let ws = null;
let reconnectDelayMs = 1000;
let reconnectTimer = null;
let status = { state: "idle", server: null, error: null, since: 0 };
let inflight = 0;

// ── lifecycle ────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
init();

async function init() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  config = { ...DEFAULTS, ...stored };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.bridgeUrl) {
      config.bridgeUrl = changes.bridgeUrl.newValue || DEFAULTS.bridgeUrl;
      reconnect();
    }
    if (changes.autoConnect) {
      config.autoConnect = !!changes.autoConnect.newValue;
      if (config.autoConnect) connect();
      else disconnect();
    }
  });
  if (config.autoConnect) connect();
}

// ── internal messaging (popup / options) ─────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "bridge:getStatus":
      sendResponse(getStatus());
      break;
    case "bridge:connect":
      connect();
      sendResponse({ ok: true });
      break;
    case "bridge:disconnect":
      disconnect();
      sendResponse({ ok: true });
      break;
    case "bridge:readPage": {
      // popup convenience: read the active tab and return a preview
      readActiveTabPreview(msg.maxChars || 800)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
      return true; // async
    }
  }
});

// ── websocket connection ─────────────────────────────────────────────────────

function setStatus(state, extra) {
  status = { state, server: extra?.server ?? status.server, error: extra?.error ?? null, since: Date.now() };
}

function getStatus() {
  return { ...status, bridgeUrl: config.bridgeUrl, connected: ws !== null && ws.readyState === WebSocket.OPEN, inflight };
}

function send(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch {
    return false;
  }
}

function connect() {
  clearTimeout(reconnectTimer);
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  disconnectSocket();
  setStatus("connecting");
  try {
    ws = new WebSocket(config.bridgeUrl);
  } catch (e) {
    setStatus("error", { error: String(e && e.message ? e.message : e) });
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    reconnectDelayMs = 1000;
    setStatus("connected");
    send({ type: "hello", protocol: PROTOCOL, name: EXT_NAME, version: EXT_VERSION });
  };
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "ping") {
      send({ type: "pong" });
      return;
    }
    if (msg.type === "welcome") {
      setStatus("connected", { server: msg.server });
      return;
    }
    if (msg.type === "request" && msg.id) {
      inflight++;
      handleRequest(msg.cmd, msg.args || {})
        .then((res) => {
          send({ type: "response", id: msg.id, ok: res.ok !== false, value: res.value ?? {}, error: res.error ?? undefined });
        })
        .catch((err) => {
          send({ type: "response", id: msg.id, ok: false, error: String(err && err.message ? err.message : err) });
        })
        .finally(() => {
          inflight--;
        });
      return;
    }
  };
  ws.onerror = () => {
    setStatus("error", { error: "socket error" });
  };
  ws.onclose = () => {
    ws = null;
    setStatus("disconnected", { error: "connection closed" });
    scheduleReconnect();
  };
}

function disconnectSocket() {
  if (ws) {
    try {
      ws.onclose = null;
      ws.close(1000, "disconnect");
    } catch {
      /* noop */
    }
    ws = null;
  }
}

function disconnect() {
  clearTimeout(reconnectTimer);
  disconnectSocket();
  setStatus("disconnected", { error: "manual disconnect" });
}

function reconnect() {
  disconnect();
  connect();
}

function scheduleReconnect() {
  if (!config.autoConnect) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connect(), reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30000);
}

// ── command dispatch ─────────────────────────────────────────────────────────

async function handleRequest(cmd, args) {
  switch (cmd) {
    case "listTabs":
      return { value: await listTabs() };
    case "activateTab":
      return { value: await activateTab(args) };
    case "navigate":
      return { value: await navigate(args) };
    case "screenshot":
      return { value: await screenshot(args) };
    default:
      // page-level commands go to the content script
      return { value: await pageCommand(cmd, args) };
  }
}

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return {
    tabs: tabs
      .sort((a, b) => a.windowId - b.windowId || a.index - b.index)
      .map((t) => ({ id: t.id, title: t.title ?? "", url: t.url ?? "", active: !!t.active, windowId: t.windowId, index: t.index })),
  };
}

async function activateTab(args) {
  const tabId = Number(args.tabId);
  if (!Number.isInteger(tabId)) throw new Error("activateTab requires an integer tabId");
  const tab = await chrome.tabs.get(tabId);
  if (!tab) throw new Error(`no tab with id ${tabId}`);
  await chrome.tabs.update(tabId, { active: true });
  if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  const after = await chrome.tabs.get(tabId);
  return { tab: { id: after.id, title: after.title ?? "", url: after.url ?? "", active: !!after.active, windowId: after.windowId, index: after.index } };
}

async function navigate(args) {
  const action = args.action || "navigate";
  let tabId = args.tabId ? Number(args.tabId) : null;
  let tab;

  if (action === "reload") {
    tabId = tabId ?? (await activeTabId());
    await chrome.tabs.reload(tabId);
    await waitForTabComplete(tabId);
    return { tab: await tabInfo(tabId), action: "reload" };
  }
  if (action === "back" || action === "forward") {
    tabId = tabId ?? (await activeTabId());
    try {
      if (action === "back") await chrome.tabs.goBack(tabId);
      else await chrome.tabs.goForward(tabId);
    } catch {
      // fallback for browsers without goBack/goForward
      await pageCommand("eval", { tabId, expression: action === "back" ? "history.back()" : "history.forward()" });
    }
    await waitForTabComplete(tabId);
    return { tab: await tabInfo(tabId), action };
  }

  const url = String(args.url || "").trim();
  if (!url) throw new Error("navigate requires a url");
  if (args.newTab) {
    tab = await chrome.tabs.create({ url, active: true });
  } else if (tabId) {
    tab = await chrome.tabs.update(tabId, { url, active: true });
  } else {
    const active = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active && active[0]) tab = await chrome.tabs.update(active[0].id, { url, active: true });
    else tab = await chrome.tabs.create({ url, active: true });
  }
  await waitForTabComplete(tab.id);
  return { tab: await tabInfo(tab.id), action: "navigate" };
}

async function screenshot(args) {
  const format = args.format === "jpeg" ? "jpeg" : "png";
  let tabId = args.tabId ? Number(args.tabId) : null;
  let tab;
  if (tabId) {
    tab = await chrome.tabs.get(tabId);
    if (!tab.active) await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  } else {
    const active = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = active && active[0] ? active[0] : null;
  }
  if (!tab) throw new Error("no tab to capture");
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format });
  const buf = base64ToBytes(dataUrl.split(",")[1] || "");
  const dims = format === "jpeg" ? jpegSize(buf) : pngSize(buf);
  return { dataUrl, width: dims?.width ?? 0, height: dims?.height ?? 0, bytes: buf.length };
}

async function pageCommand(cmd, args) {
  const tabId = await resolveTabId(args.tabId);
  const response = await chrome.tabs.sendMessage(tabId, { cmd, args: { ...args, tabId: undefined } }).catch((err) => {
    throw new Error(`cannot reach page (${err && err.message ? err.message : err}). The page may be a browser-internal page (chrome://, edge://, web store) or still loading; try browser_navigate to a regular web page first.`);
  });
  if (!response) throw new Error("the page returned no answer");
  if (response.ok === false) throw new Error(response.error || "page command failed");
  return response.value ?? {};
}

async function resolveTabId(tabId) {
  if (tabId) return Number(tabId);
  const active = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!active || !active[0]) throw new Error("no active tab");
  return active[0].id;
}

async function activeTabId() {
  const active = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!active || !active[0]) throw new Error("no active tab");
  return active[0].id;
}

async function tabInfo(tabId) {
  const t = await chrome.tabs.get(tabId);
  return { id: t.id, title: t.title ?? "", url: t.url ?? "", active: !!t.active, windowId: t.windowId, index: t.index };
}

function waitForTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ── popup helper: read the active tab ────────────────────────────────────────

async function readActiveTabPreview(maxChars) {
  const tabId = await activeTabId();
  const response = await chrome.tabs.sendMessage(tabId, { cmd: "readPage", args: { maxChars } }).catch((err) => {
    throw new Error(String(err && err.message ? err.message : err));
  });
  if (!response || response.ok === false) throw new Error((response && response.error) || "page read failed");
  const v = response.value || {};
  return { ok: true, url: v.url, title: v.title, text: v.text, tabId };
}

// ── image header helpers (no Buffer in MV3 service workers) ──────────────────

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function u32(ua, off) {
  return (ua[off] << 24) | (ua[off + 1] << 16) | (ua[off + 2] << 8) | ua[off + 3];
}

function u16(ua, off) {
  return (ua[off] << 8) | ua[off + 1];
}

function pngSize(buf) {
  if (!buf || buf.length < 24) return null;
  return { width: u32(buf, 16), height: u32(buf, 20) };
}

function jpegSize(buf) {
  if (!buf || buf.length < 4) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: u16(buf, i + 5), width: u16(buf, i + 7) };
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = u16(buf, i + 2);
    i += 2 + len;
  }
  return null;
}
