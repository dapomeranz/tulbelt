// Centralized dev/debug helpers for agent-driven toggle development.
// Defines `window.__tulbelt` in the ISOLATED world unconditionally (this file
// is listed first in the manifest, so the global exists before every other
// toggle and before `dev-probe.js`). Every helper is inert unless both the
// developer-only 'dev-tools' toggle AND developer mode are on. Disabling
// disconnects all watchers, removes the MAIN-world bridge listener, and
// clears the log buffer — clean revert, nothing persists, and the page
// itself is never touched. Exports redact the tenant hostname.
// Contract for coding agents: docs/devtools.md.

(() => {
  const FEATURE_ID = "dev-tools";
  const STORAGE_KEY = "toggles";
  const DEVELOPER_MODE_KEY = "developerMode";
  const BRIDGE_EVENT = "tulbelt:devlog";
  const REDACTED_HOST = "your-instance.tulip.co";
  const MAX_ENTRIES = 500;
  const MAX_DEPTH = 8;
  const MAX_KEYS = 40;
  const MAX_ARRAY = 50;
  const MAX_STRING = 2000;
  const MAX_HTML = 4000;
  const DEFAULT_STYLE_PROPS = [
    "display",
    "position",
    "visibility",
    "overflow",
    "z-index",
    "width",
    "height",
  ];

  let enabled = false;
  let startedAt = Date.now();
  const entries = [];
  const watchers = new Map(); // selector -> { observer, listeners: [type, fn][] }
  let bridgeBound = false;

  // ---------- sanitizer ----------

  function descriptorOf(el) {
    const d = { tag: el.tagName ? el.tagName.toLowerCase() : String(el.nodeName) };
    if (el.id) d.id = el.id;
    if (typeof el.className === "string" && el.className) {
      d.class = el.className.slice(0, 120);
    }
    return d;
  }

  function isDomNode(value) {
    return (
      typeof value === "object" &&
      value !== null &&
      typeof value.nodeType === "number" &&
      typeof value.nodeName === "string"
    );
  }

  function sanitize(value, seen = new WeakSet(), depth = 0) {
    if (value === null || value === undefined) return value;
    const t = typeof value;
    if (t === "string") {
      return value.length > MAX_STRING
        ? value.slice(0, MAX_STRING) + `…[+${value.length - MAX_STRING} chars]`
        : value;
    }
    if (t === "number" || t === "boolean") return value;
    if (t === "bigint") return value.toString() + "n";
    if (t === "function") return `[Function:${value.name || "anonymous"}]`;
    if (t === "symbol") return value.toString();
    if (depth >= MAX_DEPTH) return "[MaxDepth]";
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    if (isDomNode(value)) {
      return value.nodeType === 1 ? descriptorOf(value) : { node: value.nodeName };
    }
    if (value instanceof Error) {
      return { __error: value.name, message: value.message };
    }
    if (Array.isArray(value)) {
      const out = value.slice(0, MAX_ARRAY).map((v) => sanitize(v, seen, depth + 1));
      if (value.length > MAX_ARRAY) out.push(`…[+${value.length - MAX_ARRAY} more]`);
      return out;
    }
    const tag = Object.prototype.toString.call(value);
    if (tag !== "[object Object]") return { __host: tag };
    const out = {};
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i += 1) {
      if (i >= MAX_KEYS) {
        out["…"] = `+${keys.length - MAX_KEYS} keys`;
        break;
      }
      let v;
      try {
        v = value[keys[i]];
      } catch (_) {
        v = "[Throws]";
      }
      out[keys[i]] = sanitize(v, seen, depth + 1);
    }
    return out;
  }

  // ---------- ring buffer ----------

  function pushEntry(tag, data) {
    entries.push({ t: Date.now() - startedAt, tag, data });
    if (entries.length > MAX_ENTRIES) entries.shift();
  }

  // ---------- helpers (all inert while disabled) ----------

  function log(tag, ...args) {
    if (!enabled) return false;
    const data =
      args.length === 0 ? undefined : args.length === 1 ? sanitize(args[0]) : sanitize(args);
    pushEntry(String(tag), data);
    return true;
  }

  function resolve(target) {
    if (typeof target === "string") {
      try {
        return document.querySelector(target);
      } catch (_) {
        return null;
      }
    }
    return isDomNode(target) && target.nodeType === 1 ? target : null;
  }

  function snapshot(target, opts = {}) {
    if (!enabled) return null;
    const el = resolve(target);
    if (!el) {
      pushEntry("snapshot", { target: String(target), found: false });
      return null;
    }
    const cs = getComputedStyle(el);
    const styles = {};
    for (const prop of opts.styles || DEFAULT_STYLE_PROPS) {
      styles[prop] = cs.getPropertyValue(prop);
    }
    const r = el.getBoundingClientRect();
    const out = {
      el: descriptorOf(el),
      rect: {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
      },
      attrs: Object.fromEntries(
        [...el.attributes].slice(0, MAX_KEYS).map((a) => [a.name, a.value.slice(0, 200)]),
      ),
      styles,
      html: el.outerHTML.slice(0, opts.htmlMax ?? MAX_HTML),
    };
    pushEntry("snapshot", out);
    return out;
  }

  function labelOf(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    if (typeof el.className === "string" && el.className) {
      s += "." + el.className.trim().split(/\s+/).slice(0, 4).join(".");
    }
    return s;
  }

  function tree(target, depth = 3) {
    if (!enabled) return null;
    const root = resolve(target);
    if (!root) {
      pushEntry("tree", { target: String(target), found: false });
      return null;
    }
    const lines = [];
    const walk = (el, level) => {
      lines.push("  ".repeat(level) + labelOf(el));
      if (level >= depth) {
        if (el.children.length) {
          lines[lines.length - 1] += ` (${el.children.length} children)`;
        }
        return;
      }
      const kids = [...el.children];
      let i = 0;
      while (i < kids.length) {
        // Collapse runs of siblings with an identical label: walk the first,
        // summarize the rest.
        let j = i + 1;
        while (j < kids.length && labelOf(kids[j]) === labelOf(kids[i])) j += 1;
        if (j - i > 2) {
          walk(kids[i], level + 1);
          lines.push("  ".repeat(level + 1) + `…×${j - i - 1} more ` + labelOf(kids[i]));
        } else {
          for (let k = i; k < j; k += 1) walk(kids[k], level + 1);
        }
        i = j;
      }
    };
    walk(root, 0);
    const text = lines.join("\n");
    pushEntry("tree", text);
    return text;
  }

  function watch(selector, opts = {}) {
    if (!enabled) return false;
    if (typeof selector !== "string" || !selector) return false;
    try {
      document.querySelector(selector);
    } catch (_) {
      return false;
    }
    unwatch(selector);
    const matched = (node) => {
      if (!(node instanceof Element)) return [];
      const hits = node.matches(selector) ? [node] : [];
      hits.push(...node.querySelectorAll(selector));
      return hits;
    };
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "attributes") {
          if (m.target instanceof Element && m.target.matches(selector)) {
            pushEntry("watch:" + selector, {
              op: "attr",
              el: descriptorOf(m.target),
              attr: m.attributeName,
              old: m.oldValue,
              now: m.target.getAttribute(m.attributeName),
            });
          }
          continue;
        }
        for (const n of m.addedNodes) {
          for (const hit of matched(n)) {
            pushEntry("watch:" + selector, { op: "added", el: descriptorOf(hit) });
          }
        }
        for (const n of m.removedNodes) {
          for (const hit of matched(n)) {
            pushEntry("watch:" + selector, { op: "removed", el: descriptorOf(hit) });
          }
        }
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: opts.attributes === true,
      attributeOldValue: opts.attributes === true,
    });
    const listeners = (opts.events || []).map((type) => {
      const fn = (e) => {
        const hit = e.target instanceof Element ? e.target.closest(selector) : null;
        if (hit) pushEntry("event:" + selector, { type, el: descriptorOf(hit) });
      };
      // Capture phase so events the page stops from propagating are still seen.
      document.addEventListener(type, fn, true);
      return [type, fn];
    });
    watchers.set(selector, { observer, listeners });
    return true;
  }

  function stopWatcher({ observer, listeners }) {
    observer.disconnect();
    for (const [type, fn] of listeners) document.removeEventListener(type, fn, true);
  }

  function unwatch(selector) {
    if (selector === undefined) {
      for (const w of watchers.values()) stopWatcher(w);
      watchers.clear();
      return;
    }
    const w = watchers.get(selector);
    if (w) {
      stopWatcher(w);
      watchers.delete(selector);
    }
  }

  // ---------- export / redaction ----------

  async function buildReport() {
    let toggles = {};
    try {
      const raw = await chrome.storage.local.get(STORAGE_KEY);
      if (raw && typeof raw[STORAGE_KEY] === "object") toggles = raw[STORAGE_KEY];
    } catch (_) {}
    return {
      meta: {
        exportedAt: new Date().toISOString(),
        version: chrome.runtime.getManifest().version,
        url: location.pathname + location.search, // hostname deliberately omitted
        sessionMs: Date.now() - startedAt,
        entryCount: entries.length,
        toggles,
      },
      entries: entries.slice(),
    };
  }

  function redact(text) {
    // Hostnames contain no characters JSON escapes, so a plain split/join on
    // the serialized report catches every occurrence (hrefs inside captured
    // HTML, logged strings, …).
    return location.hostname ? text.split(location.hostname).join(REDACTED_HOST) : text;
  }

  async function exportReport() {
    if (!enabled) {
      console.log("[tulbelt:dev] Dev Tools toggle is off — nothing to export");
      return null;
    }
    const text = redact(JSON.stringify(await buildReport(), null, 2));
    api.lastExportJson = text;
    api.lastExport = JSON.parse(text);
    return api.lastExport;
  }

  async function copyReport() {
    const report = await exportReport();
    if (!report) return null;
    try {
      await navigator.clipboard.writeText(api.lastExportJson);
      console.log(`[tulbelt:dev] copied ${report.meta.entryCount} entries to clipboard`);
    } catch (e) {
      // writeText rejects while DevTools has focus. The console's built-in
      // copy() works regardless, but only when typed directly at the prompt.
      console.log(
        "[tulbelt:dev] clipboard blocked (" +
          (e?.message || e) +
          "). Run: copy(__tulbelt.lastExportJson)",
      );
    }
    return report;
  }

  // ---------- MAIN-world bridge ----------

  function onBridgeEvent(event) {
    if (!enabled) return;
    let detail = event.detail;
    if (typeof detail === "string") {
      // Object details don't reliably cross the MAIN/isolated world boundary;
      // the contract is detail: JSON.stringify({ tag, data }).
      try {
        detail = JSON.parse(detail);
      } catch (_) {
        detail = { tag: "?", data: detail };
      }
    }
    if (!detail || typeof detail !== "object") {
      pushEntry("main:?", "[no detail — dispatch with detail: JSON.stringify({ tag, data })]");
      return;
    }
    pushEntry("main:" + String(detail.tag ?? "?"), sanitize(detail.data));
  }

  // ---------- enable / disable ----------

  function apply() {
    startedAt = Date.now();
    if (!bridgeBound) {
      document.addEventListener(BRIDGE_EVENT, onBridgeEvent);
      bridgeBound = true;
    }
  }

  function revert() {
    unwatch();
    if (bridgeBound) {
      document.removeEventListener(BRIDGE_EVENT, onBridgeEvent);
      bridgeBound = false;
    }
    entries.length = 0;
  }

  async function syncFromStorage() {
    let stored = {};
    let developerMode = false;
    try {
      const raw = await chrome.storage.local.get([STORAGE_KEY, DEVELOPER_MODE_KEY]);
      if (raw && typeof raw[STORAGE_KEY] === "object") stored = raw[STORAGE_KEY];
      developerMode = raw[DEVELOPER_MODE_KEY] === true;
    } catch (_) {
      return;
    }
    const next = stored[FEATURE_ID] === true && developerMode;
    if (next === enabled) return;
    enabled = next;
    if (enabled) {
      apply();
    } else {
      revert();
    }
  }

  const api = {
    log,
    snapshot,
    tree,
    watch,
    unwatch,
    export: exportReport,
    copy: copyReport,
    clear() {
      entries.length = 0;
      startedAt = Date.now();
    },
    lastExport: null,
    lastExportJson: null,
    get enabled() {
      return enabled;
    },
  };
  window.__tulbelt = api;

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[STORAGE_KEY] || changes[DEVELOPER_MODE_KEY]) syncFromStorage();
  });

  syncFromStorage();
})();
