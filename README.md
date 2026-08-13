# dsh-browser-bridge

A **DeepSeek Harness plugin + browser extension** pair that lets DSH agents read
and control your browser вЂ” the equivalent of Kimi's WebBridge extension or
Claude's browser extension, but for your own local harness.

```
в”Њв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”ђ        WebSocket         в”Њв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”ђ
в”‚  DeepSeek Harness (dsh)   в”‚  ws://127.0.0.1:3080/     в”‚  Your browser            в”‚
в”‚                            в”‚  bridge                  в”‚  (Chrome / Edge / Yandex)в”‚
в”‚  browser_* tools          в”‚ в—„в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв–є в”‚  DSH Browser Bridge      в”‚
в”‚  (this plugin)            в”‚   commands / responses    в”‚  extension (MV3)         в”‚
в””в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”                           в””в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”
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
| `browser_snapshot` | Interactive elements (buttons, links, inputsвЂ¦) with stable CSS selectors. |
| `browser_read_page` | Visible page text (or a subtree), capped in characters. |
| `browser_click` | Click an element by CSS selector. |
| `browser_type` | Fill an input / textarea / contenteditable (native events). |
| `browser_press` | Send a key (Enter, Tab, Escape, arrowsвЂ¦). |
| `browser_scroll` | Scroll the page or a scrollable element. |
| `browser_wait` | Wait for a selector to appear/disappear, or just let the page settle. |
| `browser_screenshot` | Save a PNG/JPEG of the current tab to disk (`~/.dsh/browser-bridge/`). |
| `browser_eval` | Evaluate a JS expression in the page (content-script world). |

When the extension is not connected, every tool fails with a clear message
telling the model (and the user) how to connect it.

## Layout

```
dsh-browser-bridge/
в”њв”Ђв”Ђ lib/            # the DSH plugin (node side)
в”‚   в”њв”Ђв”Ђ index.js    # plugin entry: tools + WS upgrade route + /bridge/info
в”‚   в”њв”Ђв”Ђ ws.js       # minimal RFC 6455 WebSocket server (no dependencies)
в”‚   в”њв”Ђв”Ђ bridge.js   # connection registry, request/response correlation, timeouts
в”‚   в””в”Ђв”Ђ tools.js    # the 13 browser_* tool definitions
в”њв”Ђв”Ђ extension/      # the browser extension (Manifest V3)
в”‚   в”њв”Ђв”Ђ manifest.json
в”‚   в”њв”Ђв”Ђ background.js   # WebSocket client + chrome.tabs / messaging dispatch
в”‚   в”њв”Ђв”Ђ content.js      # DOM actions in pages (top frame only)
в”‚   в”њв”Ђв”Ђ popup.html/js   # connection status, read-this-page preview
в”‚   в”њв”Ђв”Ђ options.html/js # server URL, auto-connect, "Test connection"
в”‚   в””в”Ђв”Ђ icons/
в””в”Ђв”Ђ test/run-test.mjs   # standalone protocol test (no harness boot required)
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
prints `[browser-bridge] bridge ready вЂ” point the DSH Browser Bridge extension
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
5. Click the extension icon вЂ” the popup should show **Connected to DeepSeek
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

- `node test/run-test.mjs` вЂ” boots a real server + fake extension client and
  exercises every tool, timeouts, disconnect, and the `/bridge/info` route
  (40 assertions, no harness boot required).
- Protocol: JSON text frames. Server в†’ client `request`/`ping`/`welcome`;
  client в†’ server `hello`/`response`/`pong`. Commands are camelCase in the
  extension protocol (`listTabs`, `snapshot`, `click`, вЂ¦) and snake_case in the
  model-facing tools.

## Security notes

- The bridge binds only to the web server's loopback host (`127.0.0.1` by
  default) and has no authentication: any local process could connect to
  `/bridge` and drive the browser. Treat it like shell access.
- `browser_eval` executes JavaScript in pages вЂ” powerful by design; only grant
  it to trusted agents.
- The extension has `<all_urls>` host permissions (required to read tab URLs
  and act in any page). It talks **only** to the configured localhost URL.



