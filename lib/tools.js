// dsh-browser-bridge — model-facing browser_* tools over the extension bridge.
//
// Every tool fails with a structured BridgeError when the extension is not
// connected, so the model can read the remedy (open the extension, connect it)
// straight from the tool result.
//
// Schema note: the dsh-tools value-schema DSL expresses requiredness per
// property (`required: true` inside a property map), never as an object-level
// `required` array.

import { defineTool } from "@deepseek-ai/dsh-tools";

const NOT_CONNECTED_HINT =
	"If the browser is not connected, tell the user to open their browser, click the DSH Browser Bridge extension icon (chrome://extensions, Load unpacked), and confirm the popup shows a connected state, then retry.";

const str = { type: "string" };
const int = { type: "integer" };
const bool = { type: "boolean" };
const optStr = { type: "string" };
const optInt = { type: "integer" };
const optBool = { type: "boolean" };
const reqStr = { type: "string", required: true };
const reqInt = { type: "integer", required: true };
const reqBool = { type: "boolean", required: true };

const TAB_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		id: { ...reqInt, description: "Tab id." },
		title: str,
		url: str,
		active: bool,
		windowId: int,
		index: int,
	},
};

function genericCard(title, rawInput) {
	return { card: "generic", title, kind: "other", rawInput };
}

/**
 * Drop `undefined`-valued keys so the result survives the lossless-JSON
 * snapshot the tool runtime takes of every execute() return (a property whose
 * value is `undefined` is not lossless JSON and fails the tool result).
 */
function clean(obj) {
	const out = {};
	for (const [key, value] of Object.entries(obj)) {
		if (value !== undefined) out[key] = value;
	}
	return out;
}

/** @type {(bridge: BrowserBridge, ctx: any, config: object) => void} */
export function registerTools(ctx, bridge, config = {}) {
	const commandTimeoutMs = config.commandTimeoutMs ?? 60000;
	const run = (exec) => (cmd, args, timeoutMs) =>
		bridge.request(cmd, args, { timeoutMs, signal: exec?.signal });

	ctx.tools.register(
		defineTool({
			name: "browser_status",
			description:
				`Check whether the DSH Browser Bridge extension is connected to this DeepSeek Harness and how many commands are in flight. Use it as the first step of any browser task. ${NOT_CONNECTED_HINT}`,
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: reqBool,
						connected: reqBool,
						extension: { type: "object", additionalProperties: true, properties: { name: str, version: str } },
						pending: int,
						bridgeUrl: str,
					},
				},
				render: (_args, value) => {
					const ext = value.extension ? ` (extension ${value.extension.name} v${value.extension.version})` : "";
					return [
						{
							type: "text",
							text: value.connected
								? `Browser bridge: connected${ext}. ${value.pending} command(s) in flight.`
								: "Browser bridge: NOT connected. Open the DSH Browser Bridge extension in your browser and connect it.",
						},
					];
				},
			},
			presentCall: (args) => genericCard("Check browser connection", args),
			execute: async (_args, exec) => {
				const s = bridge.status();
				const hint = typeof config.bridgeUrlHint === "function" ? config.bridgeUrlHint() : config.bridgeUrlHint ?? "";
				return {
					ok: true,
					connected: s.connected,
					...(s.extension ? { extension: s.extension } : {}),
					pending: s.pending,
					bridgeUrl: hint,
				};
			},
		})
	);

	ctx.tools.register(
		defineTool({
			name: "browser_list_tabs",
			description: `List the user's open browser tabs (id, title, url, active flag). Use tab ids from here with browser_activate_tab / browser_navigate. ${NOT_CONNECTED_HINT}`,
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: reqBool,
						tabs: { type: "array", required: true, items: TAB_SCHEMA },
					},
				},
				render: (_args, value) => [
					{
						type: "text",
						text:
							value.tabs.length === 0
								? "No tabs found."
								: value.tabs
										.map((t) => `[${t.id}]${t.active ? " (active)" : ""} ${t.title || "(no title)"} — ${t.url || ""}`)
										.join("\n"),
					},
				],
			},
			presentCall: (args) => genericCard("List browser tabs", args),
			execute: async (_args, exec) => {
				const value = await run(exec)("listTabs", {}, commandTimeoutMs);
				return clean({ ok: true, tabs: value.tabs ?? [] });
			},
		})
	);

	ctx.tools.register(
		defineTool({
			name: "browser_activate_tab",
			description: `Bring an existing browser tab (from browser_list_tabs) to the foreground so later commands act on it. ${NOT_CONNECTED_HINT}`,
			parameters: { tabId: { ...reqInt, description: "The tab id to activate." } },
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: { ok: reqBool, tab: { ...TAB_SCHEMA, required: true } },
				},
				render: (_args, value) => [{ type: "text", text: `Activated tab [${value.tab.id}]: ${value.tab.title || "(no title)"} — ${value.tab.url || ""}` }],
			},
			presentCall: (args) => genericCard("Activate browser tab", args),
			execute: async (args, exec) => {
				const value = await run(exec)("activateTab", { tabId: args.tabId }, commandTimeoutMs);
				return clean({ ok: true, tab: value.tab ?? { id: args.tabId } });
			},
		})
	);

	ctx.tools.register(
		defineTool({
			name: "browser_navigate",
			description:
				`Navigate the browser: open a URL in the active tab (or a tabId), or perform reload/back/forward. ` +
				`action values: "navigate" (default, requires url), "reload", "back", "forward". ` +
				`Set newTab: true to open the URL in a new tab. After navigation the page needs a moment to load; follow up with browser_wait / browser_snapshot. ${NOT_CONNECTED_HINT}`,
			parameters: {
				url: { ...optStr, description: "The URL to open (required when action is navigate)." },
				action: { type: "string", enum: ["navigate", "reload", "back", "forward"], description: "What to do. Defaults to navigate." },
				tabId: { ...optInt, description: "Target tab; defaults to the active tab." },
				newTab: { ...optBool, description: "Open url in a new tab (default false)." },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: reqBool,
						action: reqStr,
						tab: TAB_SCHEMA,
						error: str,
					},
				},
				render: (_args, value) => [
					{
						type: "text",
						text: value.error
							? `Navigation (${value.action}) failed: ${value.error}`
							: `Navigation (${value.action}) ok. Tab [${value.tab.id}]: ${value.tab.title || "(no title)"} — ${value.tab.url || ""}`,
					},
				],
			},
			presentCall: (args) => genericCard("Navigate browser", args),
			execute: async (args, exec) => {
				const action = args.action ?? "navigate";
				const value = await run(exec)("navigate", { url: args.url, action, tabId: args.tabId, newTab: args.newTab }, commandTimeoutMs);
				return clean({ ok: true, action, tab: value.tab ?? {}, error: value.error ?? undefined });
			},
		})
	);

	const SNAPSHOT_ELEMENT_SCHEMA = {
		type: "object",
		additionalProperties: false,
		properties: {
			tag: reqStr,
			role: str,
			text: str,
			selector: reqStr,
			type: str,
			name: str,
			value: str,
			href: str,
			checked: bool,
		},
	};

	ctx.tools.register(
		defineTool({
			name: "browser_snapshot",
			description:
				`Take an accessibility snapshot of the current page (or a subtree via selector): the interactive elements with stable CSS selectors ` +
				`(buttons, links, inputs, selects, textareas, clickable roles), so you can act on them with browser_click / browser_type. ` +
				`Combine with browser_read_page for full text. Prefer acting on selectors returned by this tool. ${NOT_CONNECTED_HINT}`,
			parameters: {
				selector: { ...optStr, description: "Scope the snapshot to this CSS selector's subtree." },
				maxElements: { ...optInt, description: "Cap on returned elements (default 150)." },
				includeHidden: { ...optBool, description: "Include hidden elements (default false)." },
				tabId: { ...optInt, description: "Target tab; defaults to the active tab." },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: reqBool,
						url: reqStr,
						title: str,
						elements: { type: "array", required: true, items: SNAPSHOT_ELEMENT_SCHEMA },
						truncated: bool,
					},
				},
				render: (_args, value) => [
					{
						type: "text",
						text:
							`Page: ${value.title || "(no title)"} — ${value.url}\n` +
							(value.elements.length === 0
								? "No interactive elements found."
								: value.elements
										.map((e, i) => `${i + 1}. <${e.tag}>${e.role ? ` role=${e.role}` : ""}${e.type ? ` type=${e.type}` : ""} ${e.text ? JSON.stringify(truncate(e.text, 60)) : ""} → ${e.selector}`)
										.join("\n")),
					},
				],
			},
			presentCall: (args) => genericCard("Snapshot page", args),
			execute: async (args, exec) => {
				const value = await run(exec)(
					"snapshot",
					{ selector: args.selector, maxElements: args.maxElements ?? 150, includeHidden: args.includeHidden ?? false, tabId: args.tabId },
					commandTimeoutMs
				);
				return clean({ ok: true, url: value.url ?? "", title: value.title ?? "", elements: value.elements ?? [], truncated: value.truncated ?? false });
			},
		})
	);

	ctx.tools.register(
		defineTool({
			name: "browser_read_page",
			description:
				`Read the visible text of the current page (or a subtree via selector), rendered to plain text with a character cap. ` +
				`Use it to understand page content that browser_snapshot does not include (paragraphs, articles, tables-as-text). ${NOT_CONNECTED_HINT}`,
			parameters: {
				selector: { ...optStr, description: "Read only this CSS selector's subtree instead of the whole body." },
				maxChars: { ...optInt, description: "Cap on returned characters (default 20000)." },
				tabId: { ...optInt, description: "Target tab; defaults to the active tab." },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: reqBool,
						url: reqStr,
						title: str,
						text: reqStr,
						truncated: bool,
					},
				},
				render: (_args, value) => [
					{ type: "text", text: `Page: ${value.title || "(no title)"} — ${value.url}\n\n${value.text}${value.truncated ? "\n\n(truncated)" : ""}` },
				],
			},
			presentCall: (args) => genericCard("Read page", args),
			execute: async (args, exec) => {
				const value = await run(exec)("readPage", { selector: args.selector, maxChars: args.maxChars ?? 20000, tabId: args.tabId }, commandTimeoutMs);
				return clean({ ok: true, url: value.url ?? "", title: value.title ?? "", text: value.text ?? "", truncated: value.truncated ?? false });
			},
		})
	);

	ctx.tools.register(
		defineTool({
			name: "browser_click",
			description: `Click an element by CSS selector (use selectors from browser_snapshot). The element is scrolled into view first. ${NOT_CONNECTED_HINT}`,
			parameters: {
				selector: { ...reqStr, description: "CSS selector of the element to click." },
				tabId: { ...optInt, description: "Target tab; defaults to the active tab." },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: { ok: reqBool, selector: reqStr, tag: str, text: str, error: str },
				},
				render: (_args, value) => [
					{ type: "text", text: value.error ? `Click on ${value.selector} failed: ${value.error}` : `Clicked ${value.selector} (<${value.tag ?? "?"}>${value.text ? " " + JSON.stringify(truncate(value.text, 60)) : ""}).` },
				],
			},
			presentCall: (args) => genericCard("Click element", args),
			execute: async (args, exec) => {
				const value = await run(exec)("click", { selector: args.selector, tabId: args.tabId }, commandTimeoutMs);
				if (value.ok === false && value.error) return clean({ ok: false, selector: args.selector, error: value.error });
				return clean({ ok: true, selector: args.selector, tag: value.tag, text: value.text });
			},
		})
	);

	ctx.tools.register(
		defineTool({
			name: "browser_type",
			description: `Type text into an input/textarea/contenteditable by CSS selector. Set clear: true (default) to replace existing content. Fires native input/change events so React/Vue forms update. ${NOT_CONNECTED_HINT}`,
			parameters: {
				selector: { ...reqStr, description: "CSS selector of the input." },
				text: { ...reqStr, description: "Text to type." },
				clear: { ...optBool, description: "Clear existing value first (default true)." },
				tabId: { ...optInt, description: "Target tab; defaults to the active tab." },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: { ok: reqBool, selector: reqStr, error: str },
				},
				render: (_args, value) => [{ type: "text", text: value.error ? `Type into ${value.selector} failed: ${value.error}` : `Typed into ${value.selector}.` }],
			},
			presentCall: (args) => genericCard("Type into input", args),
			execute: async (args, exec) => {
				const value = await run(exec)("type", { selector: args.selector, text: args.text, clear: args.clear ?? true, tabId: args.tabId }, commandTimeoutMs);
				if (value.ok === false && value.error) return clean({ ok: false, selector: args.selector, error: value.error });
				return clean({ ok: true, selector: args.selector });
			},
		})
	);

	ctx.tools.register(
		defineTool({
			name: "browser_press",
			description:
				`Send a keyboard key to the focused element (or an optional selector, which is focused first). ` +
				`Common keys: "Enter", "Tab", "Escape", "ArrowDown", "ArrowUp", "Backspace", "Delete". ${NOT_CONNECTED_HINT}`,
			parameters: {
				key: { ...reqStr, description: "Key name (e.g. Enter, Tab, Escape)." },
				selector: { ...optStr, description: "Optional CSS selector to focus before pressing." },
				tabId: { ...optInt, description: "Target tab; defaults to the active tab." },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: { ok: reqBool, key: reqStr, error: str },
				},
				render: (_args, value) => [{ type: "text", text: value.error ? `Press ${value.key} failed: ${value.error}` : `Pressed ${value.key}.` }],
			},
			presentCall: (args) => genericCard("Press key", args),
			execute: async (args, exec) => {
				const value = await run(exec)("press", { key: args.key, selector: args.selector, tabId: args.tabId }, commandTimeoutMs);
				if (value.ok === false && value.error) return clean({ ok: false, key: args.key, error: value.error });
				return clean({ ok: true, key: args.key });
			},
		})
	);

	ctx.tools.register(
		defineTool({
			name: "browser_scroll",
			description: `Scroll the page (or a scrollable element via selector). direction: "up"|"down"|"left"|"right"|"top"|"bottom"; amount is px and defaults to the viewport size. Returns the new scroll position. ${NOT_CONNECTED_HINT}`,
			parameters: {
				direction: { ...reqStr, enum: ["up", "down", "left", "right", "top", "bottom"], description: "Scroll direction." },
				amount: { ...optInt, description: "Scroll amount in px (default: viewport size for up/down/left/right)." },
				selector: { ...optStr, description: "Scroll this element instead of the window." },
				tabId: { ...optInt, description: "Target tab; defaults to the active tab." },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: { ok: reqBool, x: int, y: int },
				},
				render: (_args, value) => [{ type: "text", text: `Scrolled. Position now (${value.x}, ${value.y}).` }],
			},
			presentCall: (args) => genericCard("Scroll", args),
			execute: async (args, exec) => {
				const value = await run(exec)("scroll", { direction: args.direction, amount: args.amount, selector: args.selector, tabId: args.tabId }, commandTimeoutMs);
				return clean({ ok: true, x: value.x ?? 0, y: value.y ?? 0 });
			},
		})
	);

	ctx.tools.register(
		defineTool({
			name: "browser_wait",
			description:
				`Wait for the page to settle: with a selector, wait until it becomes visible (condition "visible", default) or disappears ("gone"), ` +
				`polling up to timeoutMs; without a selector, just sleep timeoutMs so the page can finish loading or animations. ${NOT_CONNECTED_HINT}`,
			parameters: {
				selector: { ...optStr, description: "CSS selector to wait for." },
				condition: { type: "string", enum: ["visible", "gone"], description: "visible (default) or gone." },
				timeoutMs: { ...optInt, description: "Maximum wait in ms (default 10000)." },
				tabId: { ...optInt, description: "Target tab; defaults to the active tab." },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: { ok: reqBool, found: reqBool, selector: str, timeoutMs: int, error: str },
				},
				render: (_args, value) => [
					{ type: "text", text: value.selector ? (value.found ? `Condition met for ${value.selector}.` : `Timed out waiting for ${value.selector}.`) : `Waited ${value.timeoutMs ?? "?"}ms.` },
				],
			},
			presentCall: (args) => genericCard("Wait", args),
			execute: async (args, exec) => {
				const value = await run(exec)("wait", { selector: args.selector, condition: args.condition ?? "visible", timeoutMs: args.timeoutMs ?? 10000, tabId: args.tabId }, commandTimeoutMs);
				return clean({ ok: true, found: value.found ?? false, selector: args.selector, timeoutMs: value.timeoutMs ?? args.timeoutMs ?? 10000, error: value.error ?? undefined });
			},
		})
	);

	ctx.tools.register(
		defineTool({
			name: "browser_screenshot",
			description: `Capture a screenshot of the current tab (or a tabId). The image is saved to disk and the file path is returned — use your file tools to inspect it. ${NOT_CONNECTED_HINT}`,
			parameters: {
				tabId: { ...optInt, description: "Target tab; defaults to the active tab." },
				format: { type: "string", enum: ["png", "jpeg"], description: "Image format (default png)." },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: { ok: reqBool, path: reqStr, width: int, height: int, bytes: int, error: str },
				},
				render: (_args, value) => [
					{
						type: "text",
						text: value.error
							? `Screenshot failed: ${value.error}`
							: `Screenshot saved (${value.width ?? "?"}x${value.height ?? "?"}, ${Math.round((value.bytes ?? 0) / 1024)} KB): ${value.path}`,
					},
				],
			},
			presentCall: (args) => genericCard("Take screenshot", args),
			execute: async (args, exec) => {
				const value = await run(exec)("screenshot", { tabId: args.tabId, format: args.format ?? "png" }, commandTimeoutMs);
				if (value.ok === false && value.error) return clean({ ok: false, path: "", error: value.error });
				const file = bridge.saveScreenshot(value.dataUrl);
				return clean({ ok: true, path: file, width: value.width ?? 0, height: value.height ?? 0, bytes: value.bytes ?? 0 });
			},
		})
	);

	ctx.tools.register(
		defineTool({
			name: "browser_eval",
			description:
				`Evaluate a JavaScript expression in the page (content-script world, same DOM). The expression must be side-effect-safe to serialize: the result is JSON-stringified, so return a primitive, plain object, or array. ` +
				`Prefer the dedicated browser_* tools over eval; use eval for reads the other tools cannot express (e.g. reading an attribute, waiting for a JS value). ${NOT_CONNECTED_HINT}`,
			parameters: {
				expression: { ...reqStr, description: "JavaScript expression to evaluate (e.g. document.querySelector('h1').textContent)." },
				tabId: { ...optInt, description: "Target tab; defaults to the active tab." },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: { ok: reqBool, result: { type: "json" }, serialized: bool, error: str },
				},
				render: (_args, value) => [
					{ type: "text", text: value.error ? `Eval failed: ${value.error}` : `Result: ${JSON.stringify(value.result, null, 2)}` },
				],
			},
			presentCall: (args) => genericCard("Evaluate JS", args),
			execute: async (args, exec) => {
				const value = await run(exec)("eval", { expression: args.expression, tabId: args.tabId }, commandTimeoutMs);
				if (value.ok === false && value.error) return clean({ ok: false, result: null, serialized: false, error: value.error });
				return clean({ ok: true, result: value.result ?? null, serialized: value.serialized ?? false });
			},
		})
	);
}

function truncate(text, max) {
	const s = String(text ?? "");
	return s.length > max ? s.slice(0, max) + "…" : s;
}


