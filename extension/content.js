// DSH Browser Bridge - content script.
//
// Runs in every page (top frame only answers; iframes stay silent) and carries
// out page-level commands from the background service worker: read, snapshot,
// click, type, press, scroll, wait, eval.

(function () {
  "use strict";

  if (window.top !== window) return; // only the top frame answers

  // -- helpers ------------------------------------------------------------------

  function findEl(selector) {
    if (!selector) throw new Error("missing selector");
    const el = document.querySelector(selector);
    if (!el) throw new Error("element not found: " + selector);
    return el;
  }

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function textOf(el, max) {
    const t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    return t.length > max ? t.slice(0, max) + "..." : t;
  }

  function cssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift("#" + CSS.escape(node.id));
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((s) => s.tagName === node.tagName);
        if (sameTag.length > 1) part += ":nth-of-type(" + (sameTag.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      node = parent;
    }
    const path = parts.join(" > ");
    return path.length > 200 ? path.slice(0, 200) + "..." : path;
  }

  function serialize(value, depth) {
    depth = depth || 0;
    if (value === null || value === undefined) return { value: value ?? null, serialized: false };
    const t = typeof value;
    if (t === "string" || t === "number" || t === "boolean") return { value, serialized: false };
    if (depth > 4) return { value: String(value), serialized: true };
    if (Array.isArray(value)) {
      const out = [];
      for (const item of value.slice(0, 100)) out.push(serialize(item, depth + 1).value);
      return { value: out, serialized: false };
    }
    if (t === "object") {
      try {
        const out = {};
        let n = 0;
        for (const key of Object.keys(value)) {
          if (n++ >= 50) break;
          out[key] = serialize(value[key], depth + 1).value;
        }
        return { value: out, serialized: false };
      } catch {
        return { value: String(value), serialized: true };
      }
    }
    return { value: String(value), serialized: true };
  }

  // -- commands -----------------------------------------------------------------

  function readPage(args) {
    const root = args.selector ? findEl(args.selector) : document.body;
    let text = (root.innerText || root.textContent || "")
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    const maxChars = Math.max(0, Number(args.maxChars) || 20000);
    const truncated = text.length > maxChars;
    text = text.slice(0, maxChars);
    return { url: location.href, title: document.title, text, truncated };
  }

  const INTERACTIVE = [
    "a[href]",
    "button",
    "input",
    "select",
    "textarea",
    "[contenteditable]",
    "[role=button]",
    "[role=link]",
    "[role=checkbox]",
    "[role=radio]",
    "[role=tab]",
    "[role=menuitem]",
    "[role=switch]",
    "summary",
    "label[for]",
  ].join(",");

  function snapshot(args) {
    const maxElements = Math.max(1, Number(args.maxElements) || 150);
    const includeHidden = !!args.includeHidden;
    const root = args.selector ? findEl(args.selector) : document.body;
    let nodes;
    if (args.selector && root.matches(INTERACTIVE)) nodes = [root];
    else nodes = Array.from(root.querySelectorAll(INTERACTIVE));
    const out = [];
    for (const el of nodes) {
      if (out.length >= maxElements) break;
      if (!includeHidden && !isVisible(el)) continue;
      const info = { tag: el.tagName.toLowerCase() };
      const role = el.getAttribute("role");
      if (role) info.role = role;
      const text = textOf(el, 120);
      if (text) info.text = text;
      info.selector = cssPath(el);
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) info.type = el.type || el.tagName.toLowerCase();
        if (el.name) info.name = el.name;
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          if (el.value !== undefined && el.value !== "") info.value = String(el.value).slice(0, 80);
        }
        if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) info.checked = el.checked;
      }
      if (el instanceof HTMLAnchorElement && el.href) info.href = el.href;
      out.push(info);
    }
    return { url: location.href, title: document.title, elements: out, truncated: out.length >= maxElements };
  }

  function click(args) {
    const el = findEl(args.selector);
    if (!isVisible(el)) throw new Error("element is not visible: " + args.selector);
    el.scrollIntoView({ block: "center" });
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const events = [
      ["pointerdown", { pointerId: 1, pointerType: "mouse", isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: 1 }],
      ["mousedown", { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: 1 }],
      ["pointerup", { pointerId: 1, pointerType: "mouse", isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: 0 }],
      ["mouseup", { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: 0 }],
      ["click", { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, detail: 1 }],
    ];
    for (const [type, opts] of events) {
      try {
        el.dispatchEvent(new MouseEvent(type, opts));
      } catch {
        /* older pointer event support */
      }
    }
    return { tag: el.tagName.toLowerCase(), text: textOf(el, 120) };
  }

  const NON_TEXT_INPUTS = ["checkbox", "radio", "file", "submit", "button", "reset", "image", "range", "color"];

  function type(args) {
    const el = findEl(args.selector);
    const editable =
      el.isContentEditable || el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && NON_TEXT_INPUTS.indexOf(el.type) === -1);
    if (!editable) throw new Error("element is not editable: " + args.selector);
    el.focus();
    const text = String(args.text ?? "");
    const clear = args.clear !== false;
    if (el.isContentEditable) {
      if (clear) el.textContent = "";
      if (!document.execCommand || !document.execCommand("insertText", false, text)) {
        el.textContent += text;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
      }
    } else {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      const next = clear ? text : (el.value || "") + text;
      setter.call(el, next);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return {};
  }

  const KEY_CODES = {
    Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46,
    ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
    Home: 36, End: 35, PageUp: 33, PageDown: 34, " ": 32, Space: 32,
  };

  function press(args) {
    const el = args.selector ? findEl(args.selector) : document.activeElement || document.body;
    if (args.selector) el.focus();
    const key = String(args.key ?? "");
    const code = KEY_CODES[key] ?? 0;
    const opts = { key, code: key, keyCode: code, which: code, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent("keydown", opts));
    el.dispatchEvent(new KeyboardEvent("keypress", opts));
    el.dispatchEvent(new KeyboardEvent("keyup", opts));
    if (key === "Enter") {
      if (el.tagName === "BUTTON") {
        el.click();
      } else if ((el.tagName === "INPUT" || el.tagName === "TEXTAREA") && el.form && typeof el.form.requestSubmit === "function") {
        try {
          el.form.requestSubmit();
        } catch {
          /* noop */
        }
      }
    }
    return {};
  }

  function scroll(args) {
    const scroller = args.selector ? findEl(args.selector) : document.scrollingElement || document.documentElement;
    const step = Number(args.amount) || (args.direction === "left" || args.direction === "right" ? window.innerWidth : window.innerHeight);
    let x = scroller.scrollLeft;
    let y = scroller.scrollTop;
    switch (args.direction) {
      case "up": y = Math.max(0, y - step); break;
      case "down": y = Math.min(scroller.scrollHeight - (scroller.clientHeight || window.innerHeight), y + step); break;
      case "left": x = Math.max(0, x - step); break;
      case "right": x = Math.min(scroller.scrollWidth - (scroller.clientWidth || window.innerWidth), x + step); break;
      case "top": y = 0; break;
      case "bottom": y = scroller.scrollHeight; break;
      default: throw new Error("unknown direction: " + args.direction);
    }
    scroller.scrollTo({ left: x, top: y, behavior: "auto" });
    return { x: scroller.scrollLeft, y: scroller.scrollTop };
  }

  function wait(args) {
    const timeoutMs = Math.max(0, Number(args.timeoutMs) || 10000);
    const condition = args.condition || "visible";
    const selector = args.selector;
    if (!selector) {
      return new Promise((resolve) => setTimeout(() => resolve({ found: true, timeoutMs }), Math.min(timeoutMs, 60000)));
    }
    const start = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        let el = null;
        try {
          el = document.querySelector(selector);
        } catch {
          /* invalid selector */
        }
        const visible = !!el && isVisible(el);
        const met = condition === "gone" ? !el : visible;
        if (met) return resolve({ found: true, timeoutMs });
        if (Date.now() - start >= timeoutMs) return resolve({ found: false, timeoutMs });
        setTimeout(tick, 150);
      };
      tick();
    });
  }

  function evalInPage(args) {
    let value;
    try {
      value = (0, eval)(String(args.expression ?? ""));
    } catch (e) {
      throw new Error("eval threw: " + (e && e.message ? e.message : e));
    }
    const s = serialize(value);
    const json = JSON.stringify(s.value);
    const MAX = 200000;
    if (json && json.length > MAX) {
      return { result: JSON.parse(json.slice(0, MAX)), serialized: true };
    }
    return { result: s.value, serialized: s.serialized };
  }

  const API = { readPage, snapshot, click, type, press, scroll, wait, eval: evalInPage };

  // -- message bridge ----------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== "object" || typeof msg.cmd !== "string") return;
    const handler = API[msg.cmd];
    if (!handler) return;
    try {
      const result = handler(msg.args || {});
      if (result && typeof result.then === "function") {
        result.then((v) => sendResponse({ ok: true, value: v })).catch((e) => sendResponse({ ok: false, error: e && e.message ? e.message : String(e) }));
        return true;
      }
      sendResponse({ ok: true, value: result });
    } catch (e) {
      sendResponse({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  });
})();
