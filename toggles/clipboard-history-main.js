// Main-world half of clipboard-history. Tulip's own copies (a trigger's copy
// button, for one) never fire a `copy` event: they hand a ClipboardItem
// straight to navigator.clipboard.write(), with the payload on the text/html
// flavor. The page's Clipboard prototype is only reachable from the page's own
// world, so this half watches write()/writeText() there and forwards what was
// written to the isolated half, which owns the history and the toolbar button.
//
// Capture happens after the real write resolves, so a copy the browser refused
// is never listed. The entry crosses worlds as a JSON string on a CustomEvent —
// a string survives the world boundary where an object detail may not.
//
// The wrappers stay installed for the life of the page (same reasoning as
// paste-trigger-anywhere-main.js: Tulip may hold a reference, and unwrapping
// under it is riskier than a no-op). With the toggle off they capture nothing
// and change nothing.

(() => {
  const ENABLED_ATTR = "data-tulbelt-clip-history-enabled";
  const COPY_EVENT = "tulbelt:clipboard-history-copy";
  const FLAVORS = ["text/plain", "text/html"];

  const clipProto = window.Clipboard && window.Clipboard.prototype;
  if (!clipProto) return;

  function enabled() {
    return document.documentElement.getAttribute(ENABLED_ATTR) === "true";
  }

  // A write() call does not say whether it is a copy or a cut, so it is told
  // apart by what the user just did: a write shortly after a `cut` event or a
  // Ctrl/Cmd+X keydown is a cut. Captured at the window so the page's own
  // handlers can't hide either from us.
  const CUT_WINDOW_MS = 1000;
  let lastCutAt = -Infinity;
  function noteCut() {
    lastCutAt = performance.now();
  }
  window.addEventListener("cut", noteCut, true);
  window.addEventListener(
    "keydown",
    (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && String(e.key).toLowerCase() === "x") noteCut();
    },
    true,
  );
  function currentOp() {
    return performance.now() - lastCutAt < CUT_WINDOW_MS ? "cut" : "copy";
  }

  function report(entry) {
    document.dispatchEvent(new CustomEvent(COPY_EVENT, { detail: JSON.stringify(entry) }));
  }

  async function reportItems(items, op) {
    const item = (items || []).find((i) => i && i.types);
    if (!item) return;
    const entry = { op };
    for (const flavor of FLAVORS) {
      if (!item.types.includes(flavor)) continue;
      entry[flavor === "text/html" ? "html" : "text"] = await (await item.getType(flavor)).text();
    }
    report(entry);
  }

  const originalWrite = clipProto.write;
  if (originalWrite) {
    clipProto.write = function (items, ...rest) {
      const result = originalWrite.call(this, items, ...rest);
      try {
        if (enabled()) {
          const op = currentOp();
          Promise.resolve(result)
            .then(() => reportItems(items, op))
            .catch(() => {});
        }
      } catch (_) {}
      return result;
    };
  }

  const originalWriteText = clipProto.writeText;
  if (originalWriteText) {
    clipProto.writeText = function (text, ...rest) {
      const result = originalWriteText.call(this, text, ...rest);
      try {
        if (enabled()) {
          const op = currentOp();
          Promise.resolve(result)
            .then(() => report({ op, text: String(text) }))
            .catch(() => {});
        }
      } catch (_) {}
      return result;
    };
  }
})();
