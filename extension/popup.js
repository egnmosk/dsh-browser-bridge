// DSH Browser Bridge — popup.

const stateEl = document.getElementById("state");
const detailEl = document.getElementById("detail");
const dotEl = document.getElementById("dot");
const previewEl = document.getElementById("preview");
const previewTextEl = document.getElementById("previewText");

function refresh() {
  chrome.runtime.sendMessage({ type: "bridge:getStatus" }, (status) => {
    if (chrome.runtime.lastError) return;
    const connected = !!status.connected;
    dotEl.className = "dot " + (connected ? "ok" : "bad");
    stateEl.textContent = connected ? "Connected to DeepSeek Harness" : capitalize(status.state || "disconnected");
    detailEl.textContent = status.bridgeUrl || "";
  });
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

document.getElementById("connect").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "bridge:connect" }, () => {
    setTimeout(refresh, 400);
  });
});

document.getElementById("read").addEventListener("click", () => {
  previewEl.hidden = false;
  previewTextEl.textContent = "Reading…";
  chrome.runtime.sendMessage({ type: "bridge:readPage", maxChars: 900 }, (res) => {
    if (chrome.runtime.lastError) {
      previewTextEl.textContent = "Error: " + chrome.runtime.lastError.message;
      return;
    }
    if (res && res.ok) {
      previewTextEl.textContent = (res.title ? res.title + "\n" : "") + res.text;
    } else {
      previewTextEl.textContent = "Error: " + (res && res.error ? res.error : "unknown");
    }
  });
});

refresh();
setInterval(refresh, 2000);
