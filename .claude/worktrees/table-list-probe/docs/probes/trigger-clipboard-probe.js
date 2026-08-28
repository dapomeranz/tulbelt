// Throwaway capture probe for the trigger copy/paste investigation
// (docs/paste-trigger-anywhere.md). Paste the whole file into the DevTools
// console of an app editor tab, in the **page** context ("top"), NOT the
// Tulbelt isolated-world context — it has to see Tulip's own
// `navigator.clipboard` calls, and the isolated world has a different one.
//
// It records, and never changes, every layer a trigger copy/paste could
// travel through:
//   * Clipboard API   — writeText / readText / write / read (+ caller stack).
//     A `write()` is unpacked: its ClipboardItem types and their text.
//   * clipboard events — copy / cut / paste, captured before AND after Tulip's
//     own handlers (capture phase sees the payload Tulip is about to read;
//     bubble phase shows whether Tulip preventDefault'ed it)
//   * DataTransfer.getData — the read Tulip's own paste handler performs, so
//     the payload is captured exactly as Tulip asks for it
//   * Tulip's own `[Copy/Paste]` clientLogger lines, which bracket the paste:
//     "Pasting trigger in app editor" then "Pasting trigger, opening trigger
//     editor". A refused paste logs the first and not the second.
//   * document.execCommand('copy'|'cut'|'paste')
//   * localStorage / sessionStorage writes (minus the per-keystroke noise)
//   * Ctrl/Cmd+C/X/V keydowns, with the DOM target
//   * clicks on any button (so the trigger row's copy/cut icons identify
//     themselves by testid/aria-label)
//   * console.warn / console.error (a refused paste often complains there)
//
// Two helpers to call by hand, both filed into the same report:
//   __tpaDecode('App started')  — decode the trigger currently on the clipboard
//     (run once per surface to collect the `event` vocabulary)
//   __tpaPane('step triggers')  — structural dump of the open trigger list, for
//     working out where a "Paste trigger" button can be injected
//
// Then: `copy(__tpaDump())` for just the copy/paste-relevant entries (what to
// send back), or `copy(__tpaReport())` for everything. Both redact the
// hostname. __tpaStop() restores every patched function.

(() => {
  if (window.__tpa) {
    console.log("[tpa] already installed — run __tpaStop() first to reinstall");
    return;
  }

  const MAX_STRING = 20000;
  const MAX_ENTRIES = 600;
  const entries = [];
  const t0 = performance.now();
  /** Undo functions for every patch, run by __tpaStop(). */
  const restores = [];

  function clipStr(value) {
    if (typeof value !== "string") return value;
    return value.length > MAX_STRING
      ? value.slice(0, MAX_STRING) + "…(+" + (value.length - MAX_STRING) + " chars)"
      : value;
  }

  function rec(tag, data) {
    entries.push({ t: Math.round(performance.now() - t0), tag, data });
    if (entries.length > MAX_ENTRIES) entries.shift();
    try {
      console.log("[tpa]", tag, data);
    } catch (_) {}
  }

  function stack() {
    try {
      return new Error().stack.split("\n").slice(2, 7).join(" | ");
    } catch (_) {
      return null;
    }
  }

  function describe(node) {
    if (!node || typeof node !== "object" || node.nodeType !== 1) {
      return node === document ? "#document" : node === window ? "#window" : String(node);
    }
    const out = {
      tag: node.tagName,
      testid: node.getAttribute?.("data-testid") || undefined,
      aria: node.getAttribute?.("aria-label") || undefined,
      cls: (node.getAttribute?.("class") || "").slice(0, 140) || undefined,
      text: (node.textContent || "").trim().slice(0, 60) || undefined,
    };
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
  }

  // ── Clipboard API ───────────────────────────────────────────────────────────
  function unpackClipboardItems(items) {
    for (const item of items || []) {
      for (const type of (item && item.types) || []) {
        try {
          item
            .getType(type)
            .then((blob) => blob.text())
            .then((text) => rec("clipboard.write:item", { type, text: clipStr(text) }))
            .catch((err) => rec("clipboard.write:item:failed", { type, error: String(err) }));
        } catch (err) {
          rec("clipboard.write:item:failed", { type, error: String(err) });
        }
      }
    }
  }

  // Patch the prototype (catches references Tulip grabbed early) and the live
  // navigator.clipboard instance (catches a shadowed own property).
  function patchClipboard(target, label) {
    if (!target) return;
    for (const method of ["writeText", "readText", "write", "read"]) {
      const original = target[method];
      if (typeof original !== "function") continue;
      const isRead = method === "readText" || method === "read";
      const patched = function (...args) {
        const where = stack();
        if (!isRead) {
          rec("clipboard." + method, {
            via: label,
            arg:
              method === "writeText"
                ? clipStr(args[0])
                : (args[0] || []).map((item) => item && item.types),
            stack: where,
          });
          // write() hands over ClipboardItems, whose payload is a Blob per
          // type — unpack them so the copied trigger itself is in the report.
          if (method === "write") unpackClipboardItems(args[0]);
        }
        let result;
        try {
          result = original.apply(this, args);
        } catch (err) {
          rec("clipboard." + method + ":threw", { via: label, error: String(err), stack: where });
          throw err;
        }
        if (isRead && result && typeof result.then === "function") {
          return result.then(
            (value) => {
              rec("clipboard." + method + ":resolved", {
                via: label,
                value:
                  method === "readText"
                    ? clipStr(value)
                    : (value || []).map((item) => item && item.types),
                stack: where,
              });
              return value;
            },
            (err) => {
              rec("clipboard." + method + ":rejected", {
                via: label,
                error: String(err),
                stack: where,
              });
              throw err;
            },
          );
        }
        return result;
      };
      try {
        target[method] = patched;
        restores.push(() => {
          if (target[method] === patched) target[method] = original;
        });
      } catch (_) {}
    }
  }
  patchClipboard(window.Clipboard && window.Clipboard.prototype, "Clipboard.prototype");
  try {
    if (Object.prototype.hasOwnProperty.call(navigator, "clipboard")) {
      patchClipboard(navigator.clipboard, "navigator.clipboard");
    }
  } catch (_) {}

  // ── execCommand ─────────────────────────────────────────────────────────────
  const origExec = document.execCommand;
  if (typeof origExec === "function") {
    document.execCommand = function (cmd, ...rest) {
      const result = origExec.call(this, cmd, ...rest);
      if (/^(copy|cut|paste)$/i.test(String(cmd))) {
        rec("execCommand", { cmd, result, stack: stack() });
      }
      return result;
    };
    restores.push(() => {
      document.execCommand = origExec;
    });
  }

  // ── clipboard events ────────────────────────────────────────────────────────
  // Set while the probe itself reads a DataTransfer, so the getData wrapper
  // below doesn't record our own reads as Tulip's.
  let probeReading = false;

  function readDataTransfer(dt) {
    const out = {};
    probeReading = true;
    try {
      for (const type of dt ? dt.types || [] : []) out[type] = clipStr(dt.getData(type));
    } catch (err) {
      out.__error = String(err);
    } finally {
      probeReading = false;
    }
    return out;
  }

  // The read Tulip's own paste handler performs. Tells us which MIME type it
  // asks for — the exact hook a rewrite would use.
  const origGetData = DataTransfer.prototype.getData;
  DataTransfer.prototype.getData = function (type) {
    const value = origGetData.call(this, type);
    if (!probeReading) {
      rec("DataTransfer.getData", { type, value: clipStr(value), stack: stack() });
    }
    return value;
  };
  restores.push(() => {
    DataTransfer.prototype.getData = origGetData;
  });

  function onClipboardEvent(phase) {
    return (e) => {
      rec("event:" + e.type + ":" + phase, {
        isTrusted: e.isTrusted,
        defaultPrevented: e.defaultPrevented,
        target: describe(e.target),
        data: readDataTransfer(e.clipboardData),
      });
    };
  }
  for (const type of ["copy", "cut", "paste"]) {
    const capture = onClipboardEvent("capture");
    const bubble = onClipboardEvent("bubble");
    window.addEventListener(type, capture, true);
    window.addEventListener(type, bubble, false);
    restores.push(() => {
      window.removeEventListener(type, capture, true);
      window.removeEventListener(type, bubble, false);
    });
  }

  // ── storage writes ──────────────────────────────────────────────────────────
  // Tulip rewrites these on every keystroke and every render; recording them
  // buries the copy/paste traffic.
  const STORAGE_NOISE = /^(tulip-last-activity|featureFlag\.)/;

  const origSet = Storage.prototype.setItem;
  const origRemove = Storage.prototype.removeItem;
  Storage.prototype.setItem = function (key, value) {
    if (!STORAGE_NOISE.test(String(key))) {
      rec("storage.setItem", { key, value: clipStr(String(value)), stack: stack() });
    }
    return origSet.call(this, key, value);
  };
  Storage.prototype.removeItem = function (key) {
    rec("storage.removeItem", { key, stack: stack() });
    return origRemove.call(this, key);
  };
  restores.push(() => {
    Storage.prototype.setItem = origSet;
    Storage.prototype.removeItem = origRemove;
  });

  // ── keyboard + clicks ───────────────────────────────────────────────────────
  const onKeydown = (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (!/^[cvx]$/i.test(e.key)) return;
    rec("keydown", {
      key: e.key,
      target: describe(e.target),
      activeElement: describe(document.activeElement),
      // What the editor thinks is selected right now — the paste target.
      selected: [...document.querySelectorAll('[data-testid="widget"].selected, .widget.selected')]
        .slice(0, 3)
        .map(describe),
      contextPane: [...document.querySelectorAll("[data-testid^='context-pane']")]
        .slice(0, 6)
        .map((el) => el.getAttribute("data-testid")),
    });
  };
  window.addEventListener("keydown", onKeydown, true);
  restores.push(() => window.removeEventListener("keydown", onKeydown, true));

  const onClick = (e) => {
    const btn = e.target && e.target.closest && e.target.closest('button, [role="button"], a');
    if (!btn) return;
    const row = btn.closest('[class*="triggerRow"], [class*="triggerItem"], [data-testid]');
    rec("click", { button: describe(btn), row: row === btn ? undefined : describe(row) });
  };
  window.addEventListener("click", onClick, true);
  restores.push(() => window.removeEventListener("click", onClick, true));

  // ── console ─────────────────────────────────────────────────────────────────
  // warn/error wholesale (refusals often complain there), plus Tulip's own
  // clientLogger `[Copy/Paste]` lines off console.log/info — those bracket the
  // paste and their second line is missing exactly when a paste is refused.
  // Their second argument is a context object worth keeping whole.
  const COPY_PASTE_LINE = /\[Copy\/Paste\]/;

  function recordConsole(level, args, always) {
    const first = typeof args[0] === "string" ? args[0] : "";
    if (!always && !COPY_PASTE_LINE.test(first)) return;
    // Skip the probe's own output so wrapping console.log can't recurse.
    if (first.startsWith("[tpa]")) return;
    let context;
    try {
      context = args[1] && typeof args[1] === "object" ? JSON.parse(JSON.stringify(args[1])) : null;
    } catch (_) {
      context = "(unserializable)";
    }
    rec("console." + level, { message: clipStr(first), context });
  }

  for (const [level, always] of [
    ["warn", true],
    ["error", true],
    ["log", false],
    ["info", false],
  ]) {
    const original = console[level];
    if (typeof original !== "function") continue;
    const patched = function (...args) {
      try {
        recordConsole(level, args, always);
      } catch (_) {}
      return original.apply(this, args);
    };
    console[level] = patched;
    restores.push(() => {
      if (console[level] === patched) console[level] = original;
    });
  }

  // ── report ──────────────────────────────────────────────────────────────────
  window.__tpa = { entries, rec };

  window.__tpaNote = (label) => {
    rec("note", { label });
    return "noted";
  };

  // Decode whatever trigger is on the clipboard right now, and file it under a
  // label. Run once per surface (App started, On step exit, a custom widget, …)
  // to collect the `event` vocabulary the paste buttons have to write.
  window.__tpaDecode = async (label = "clipboard") => {
    // navigator.clipboard.read() refuses while the document is unfocused, and
    // typing this in the console means DevTools holds focus. Wait for the page
    // to get it back — clicking the canvas background is enough and changes
    // nothing but the selection.
    if (!document.hasFocus()) {
      console.log("[tpa] click the page (canvas background is fine) — waiting for focus…");
      await new Promise((resolve) => {
        const done = () => {
          window.removeEventListener("focus", done);
          document.removeEventListener("click", done, true);
          resolve();
        };
        window.addEventListener("focus", done, { once: true });
        document.addEventListener("click", done, true);
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    try {
      const items = await navigator.clipboard.read();
      const item = items.find((i) => i.types.includes("text/html"));
      if (!item) {
        rec("decode:none", { label, types: items.map((i) => i.types) });
        return "no text/html on the clipboard";
      }
      const html = await item.getType("text/html").then((b) => b.text());
      const match = html.match(/data-tulip-clipboard="([^"]+)"/);
      if (!match) {
        rec("decode:none", { label, html: clipStr(html) });
        return "no data-tulip-clipboard payload";
      }
      const payload = JSON.parse(atob(match[1]));
      rec("decode", { label, payload });
      // Log the binding as a string, not an object — the console collapses
      // nested objects and `event` is exactly what gets hidden.
      const t = payload.trigger || {};
      console.log(
        "[tpa] decoded " +
          label +
          " → " +
          JSON.stringify({
            name: t.name,
            event: t.event,
            stepId: t.stepId ?? null,
            widgetId: t.widgetId ?? null,
          }),
      );
      return payload;
    } catch (err) {
      rec("decode:failed", { label, error: String(err) });
      if (String(err).includes("not focused")) {
        return "failed: the page lost focus again — click the page, then re-run";
      }
      return "failed: " + String(err);
    }
  };

  // Every decode so far, flattened to the fields that matter: the event
  // vocabulary in one blob. `copy(__tpaEvents())` is what to send back.
  window.__tpaEvents = () => {
    const rows = entries
      .filter((e) => e.tag === "decode")
      .map((e) => {
        const t = (e.data.payload && e.data.payload.trigger) || {};
        return {
          label: e.data.label,
          name: t.name,
          clipboardType: e.data.payload && e.data.payload.clipboardType,
          event: t.event,
          stepId: t.stepId ?? null,
          widgetId: t.widgetId ?? null,
          // Anything else that varies by surface shows up here.
          otherKeys: Object.keys(t).filter(
            (k) =>
              ![
                "id",
                "name",
                "versionSetId",
                "importFamilyId",
                "appVersionId",
                "stepId",
                "widgetId",
                "disabled",
                "workspaces",
                "created",
                "lastModified",
                "clauses",
                "event",
              ].includes(k),
          ),
        };
      });
    const json = JSON.stringify(rows, null, 2)
      .split(location.hostname)
      .join("your-instance.tulip.co");
    console.log(json);
    return json;
  };

  // Structural dump of a trigger list / context pane, for working out where a
  // "Paste trigger" button can be injected and how a section names itself.
  // Run it with the surface open: __tpaPane('step triggers').
  window.__tpaPane = (label = "pane", root = null) => {
    const start =
      (typeof root === "string" ? document.querySelector(root) : root) ||
      document.querySelector('[class*="context-pane"], [data-testid^="context-pane"]') ||
      document.querySelector('[class*="triggers"]');
    if (!start) {
      rec("pane:none", { label });
      return "no pane found — pass a selector: __tpaPane('label', '.some-selector')";
    }
    const lines = [];
    (function walk(el, depth) {
      if (depth > 7 || lines.length > 400) return;
      const testid = el.getAttribute("data-testid");
      const cls = (el.getAttribute("class") || "").split(/\s+/)[0] || "";
      const own = [...el.childNodes]
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent.trim())
        .join(" ")
        .slice(0, 50);
      lines.push(
        "  ".repeat(depth) +
          el.tagName.toLowerCase() +
          (testid ? "[" + testid + "]" : "") +
          (cls ? "." + cls : "") +
          (own ? " — " + own : ""),
      );
      for (const child of el.children) walk(child, depth + 1);
    })(start, 0);
    const text = lines.join("\n");
    rec("pane", { label, tree: clipStr(text) });
    console.log("[tpa] pane " + label + "\n" + text);
    return text;
  };

  window.__tpaReport = () => {
    const report = {
      meta: {
        at: new Date().toISOString(),
        url: location.pathname + location.search,
        entryCount: entries.length,
        // Which storage keys exist now — a trigger clipboard may live in one.
        localStorageKeys: Object.keys(localStorage).slice(0, 200),
        sessionStorageKeys: Object.keys(sessionStorage).slice(0, 200),
      },
      entries,
    };
    const host = location.hostname;
    const json = JSON.stringify(report, null, 2).split(host).join("your-instance.tulip.co");
    window.__tpaJson = json;
    return json;
  };

  // The subset worth sending back: everything that carries a payload or marks
  // where a paste stopped. Drops clicks, keydowns and storage chatter.
  const DUMP_TAGS =
    /^(clipboard\.|event:(copy|cut|paste)|DataTransfer\.getData|console\.|note|decode|pane)/;
  window.__tpaDump = () => {
    const json = JSON.stringify(
      {
        meta: { at: new Date().toISOString(), url: location.pathname, of: entries.length },
        entries: entries.filter((e) => DUMP_TAGS.test(e.tag)),
      },
      null,
      2,
    )
      .split(location.hostname)
      .join("your-instance.tulip.co");
    window.__tpaJson = json;
    return json;
  };

  window.__tpaStop = () => {
    while (restores.length) {
      try {
        restores.pop()();
      } catch (_) {}
    }
    delete window.__tpa;
    return "probe removed (report helpers still available)";
  };

  console.log(
    "[tpa] armed. Reproduce: copy a trigger, paste it on a same-type target, " +
      "then paste it on a different-type target. Then run copy(__tpaDump()).",
  );
})();
