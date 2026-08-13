# dsh-browser-bridge

A **DeepSeek Harness plugin + browser extension** pair that lets DSH agents read
and control your browser - the equivalent of Kimi's WebBridge extension or
Claude's browser extension, but for your own local harness.

```
+-----------------------------+        WebSocket         +--------------------------+
|  DeepSeek Harness (dsh)    |  ws://127.0.0.1:3080/     |  Your browser            |
|                             |  bridge                  |  (Chrome / Edge / Yandex)|
|  browser_* tools           | <------------------------> |  DSH Browser Bridge      |
|  (this plugin)             |   commands / responses    |  extension (MV3)         |
+-----------------------------+                          +--------------------------+
```

The DSH side exposes 13 model-facing tools; the extension side executes them in
the browser (tabs, DOM, clicks, typing, scrolling, screenshots, eval).

## Agent tools

| Tool | What it does |
|---|---|
| `browser_status` | Is the extension connected? Bridge URL, pending commands. |
| `browser_list_tabs` | List open tabs (id, title, url, active). |
| `browser_activate_tab` | Bring a tab to the foreground. |
| `browser_navigate` | Open a URL, or reload / back / forward; optional new tab. |
| `browser_snapshot` | Interactive elements (buttons, links, inputs...) with stable CSS selectors. |
| `browser_read_page` | Visible page text (or a subtree), capped in characters. |
| `browser_click` | Click an element by CSS selector. |
| `browser_type` | Fill an input / textarea / contenteditable (native events). |
| `browser_press` | Send a key (Enter, Tab, Escape, arrows...). |
| `browser_scroll` | Scroll the page or a scrollable element. |
| `browser_wait` | Wait for a selector to appear/disappear, or just let the page settle. |
| `browser_screenshot` | Save a PNG/JPEG of the current tab to disk (`~/.dsh/browser-bridge/`). |
| `browser_eval` | Evaluate a JS expression in the page (content-script world). |

When the extension is not connected, every tool fails with a clear message
telling the model (and the user) how to connect it.

## Layout

```
dsh-browser-bridge/
|-- lib/            # the DSH plugin (node side)
|   |-- index.js    # plugin entry: tools + WS upgrade route + /bridge/info
|   |-- ws.js       # minimal RFC 6455 WebSocket server (no dependencies)
|   |-- bridge.js   # connection registry, request/response correlation, timeouts
|   `-- tools.js    # the 13 browser_* tool definitions
|-- extension/      # the browser extension (Manifest V3)
|   |-- manifest.json
|   |-- background.js   # WebSocket client + chrome.tabs / messaging dispatch
|   |-- content.js      # DOM actions in pages (top frame only)
|   |-- popup.html/js   # connection status, read-this-page preview
|   |-- options.html/js # server URL, auto-connect, "Test connection"
|   `-- icons/
`-- test/run-test.mjs   # standalone protocol test (no harness boot required)
```

## Install

1. The package lives in the web profile's node_modules
   (`~/.dsh/profiles/node_modules/dsh-browser-bridge`).
2. Registered in `~/.dsh/profiles/web/cordis.patch.yml` as row
   `browser-bridge` (`name: dsh-browser-bridge`).
3. Recorded in `~/.dsh/profiles/web/package.json` dependencies.

Verify the composition at any time:

```sh
dsh --profile web --dump-config | grep -A 3 browser-bridge
```

## Activate

The plugin is loaded at boot, so restart `dsh web` once after installing
(restarting drops the GUI for a few seconds; it comes back on the same URL).
After the restart, the server
prints `[browser-bridge] bridge ready - point the DSH Browser Bridge extension
at ws://127.0.0.1:3080/bridge`, and `http://127.0.0.1:3080/bridge/info`
answers JSON. Verify with:

```sh
dsh --profile web --dump-config | grep -A 3 browser-bridge
curl http://127.0.0.1:3080/bridge/info   # -> {"name":"dsh-browser-bridge",...}
```

## Load the extension

1. Open your browser: Chrome, Edge, or Yandex (all Chromium).
2. Go to `chrome://extensions` (Edge: `edge://extensions`, Yandex:
   `browser://extensions`).
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the `extension` folder of this package.
5. Click the extension icon - the popup should show **Connected to DeepSeek
   Harness**.

The default server URL is `ws://127.0.0.1:3080/bridge`, which matches `dsh web`
running on its default port. If your harness listens on another port, open the
extension's **Options** page, set the URL, and use **Test connection**.

Then just ask an agent, for example:

> Use the browser to open example.com, read the page, and click the first link.

## Configuration (cordis.patch.yml)

| Key | Default | Meaning |
|---|---|---|
| `path` | `/bridge` | WebSocket endpoint path on the web server. |
| `commandTimeoutMs` | `60000` | How long a tool waits for the extension to answer. |
| `screenshotDir` | `~/.dsh/browser-bridge` | Where screenshots are saved. |
| `maxMessageBytes` | `8 MiB` | Max WS message size (screenshots travel over WS). |

## Development

- `node test/run-test.mjs` - boots a real server + fake extension client and
  exercises every tool, timeouts, disconnect, and the `/bridge/info` route
  (40 assertions, no harness boot required).
- Protocol: JSON text frames. Server -> client `request`/`ping`/`welcome`;
  client -> server `hello`/`response`/`pong`. Commands are camelCase in the
  extension protocol (`listTabs`, `snapshot`, `click`, ...) and snake_case in the
  model-facing tools.

## Security notes

- The bridge binds only to the web server's loopback host (`127.0.0.1` by
  default) and has no authentication: any local process could connect to
  `/bridge` and drive the browser. Treat it like shell access.
- `browser_eval` executes JavaScript in pages - powerful by design; only grant
  it to trusted agents.
- The extension has `<all_urls>` host permissions (required to read tab URLs
  and act in any page). It talks **only** to the configured localhost URL.



