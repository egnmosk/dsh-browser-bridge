// DSH Browser Bridge - options page.

const DEFAULTS = { bridgeUrl: "ws://127.0.0.1:3080/bridge", autoConnect: true };
const urlEl = document.getElementById("bridgeUrl");
const autoEl = document.getElementById("autoConnect");
const msgEl = document.getElementById("msg");

function setMsg(text, kind) {
  msgEl.textContent = text;
  msgEl.className = kind || "";
}

async function load() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  urlEl.value = stored.bridgeUrl || DEFAULTS.bridgeUrl;
  autoEl.checked = stored.autoConnect !== false;
}

document.getElementById("save").addEventListener("click", async () => {
  let url = urlEl.value.trim();
  if (!/^wss?:\/\/.+/.test(url)) {
    setMsg("Invalid WebSocket URL. Expected ws://127.0.0.1:3080/bridge", "err");
    return;
  }
  await chrome.storage.local.set({ bridgeUrl: url, autoConnect: autoEl.checked });
  setMsg("Saved. The extension will reconnect using the new URL.", "ok");
  setTimeout(() => setMsg("", ""), 3000);
});

document.getElementById("test").addEventListener("click", async () => {
  let url = urlEl.value.trim();
  setMsg("Testing...", "");
  try {
    const httpUrl = url.replace(/^ws/, "http") + "/info";
    const res = await fetch(httpUrl, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const info = await res.json();
    const ws = new WebSocket(url);
    const result = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no response from " + url)), 4000);
      ws.onopen = () => { clearTimeout(t); resolve("ok"); };
      ws.onerror = () => { clearTimeout(t); reject(new Error("websocket handshake failed")); };
    });
    ws.close();
    setMsg("Connected! Server: " + (info.name || "?") + " (protocol " + (info.protocol || "?") + "). The bridge is ready.", "ok");
  } catch (e) {
    setMsg("Test failed: " + (e && e.message ? e.message : e) + "\nMake sure `dsh web` is running and the port matches the URL of the dsh web UI you opened.", "err");
  }
});

load();
