// Adds a clipboard-history button to the app editor's top toolbar, beside the
// Variables button, listing the most recent things copied on tulip.co. Clicking
// an entry puts it back on the system clipboard, ready for a normal Ctrl+V.
//
// A browser extension cannot read the operating system's clipboard history —
// there is no such API — so the history is built by watching copies as they
// happen, through the three routes a copy on a Tulip page can take:
//
//   * a `copy`/`cut` event — ordinary text selections and fields. Read at the
//     bubble phase on window, after the page's own handlers have had their
//     chance to setData(); if nobody did, the browser is about to copy the
//     selection, so that is what gets recorded.
//   * the page calling navigator.clipboard.write()/writeText() — how Tulip
//     copies triggers. Only visible from the page's world; see
//     clipboard-history-main.js, which forwards those here.
//   * Tulbelt's own writeText() calls (Copy ID, option-set export). Those run
//     in this isolated world, which has its own Clipboard prototype, so it is
//     wrapped here while the toggle is on and put back when it goes off.
//
// Tulip's structured copies ride on text/html as
// `<span data-tulip-clipboard="<base64 JSON>">`. That flavor is stored verbatim
// and written back verbatim, so a re-copied trigger pastes exactly as the
// original did. Any other text/html is dropped — plain text is what the user
// expects back from a text copy.
//
// History lives in chrome.storage.local, so it is shared across Tulip tabs and
// survives reloads. Switching the toggle off stops recording and removes the
// button but keeps the stored list; "Clear" in the popover empties it.
//
// The toolbar placement mirrors move-variables-to-toolbar.js (same anchors,
// same cloned wrapper) and is ordered so the two buttons end up adjacent
// whichever script renders first.

(() => {
  const { registerToggle, addedNodesObserver, ensureStyles, removeStyles } = window.__tulbeltLib;

  const FEATURE_ID = "clipboard-history";
  const HISTORY_KEY = "clipboardHistory";
  const STYLE_ID = "tulbelt-clip-history-styles";
  const BUTTON_ID = "tulbelt-clip-history-button";
  const POPOVER_ID = "tulbelt-clip-history-popover";
  const ENABLED_ATTR = "data-tulbelt-clip-history-enabled";
  const COPY_EVENT = "tulbelt:clipboard-history-copy";
  const TULIP_CLIP_ATTR = "data-tulip-clipboard";
  const VARIABLES_CLONE_SELECTOR = "[data-tulbelt-variables-clone]";
  const TOOLBAR_ANCHOR_SELECTORS = ["#app-editor-translation", "#app-editor-snapshot"];
  const TRANSLATION_DROPDOWN_SELECTOR = '[data-testid="translationTargetLocalDropdown"]';
  const LABEL = "Clipboard history";

  const MAX_ENTRIES = 25;
  // chrome.storage.local holds ~10MB for the whole extension; keep well inside.
  const MAX_ENTRY_CHARS = 500000;
  const MAX_TOTAL_CHARS = 2000000;
  const PREVIEW_CHARS = 300;
  const FEEDBACK_MS = 700;

  const CLIPBOARD_SVG = `<svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 2h-4.18C14.4.84 13.3 0 12 0S9.6.84 9.18 2H5c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm7 18H5V4h2v3h10V4h2v16z"></path></svg>`;

  // Leading icon on each row: how the entry reached the clipboard.
  const OP_ICONS = {
    copy: {
      label: "Copied",
      path: "M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z",
    },
    cut: {
      label: "Cut",
      path: "M9.64 7.64c.23-.5.36-1.05.36-1.64 0-2.21-1.79-4-4-4S2 3.79 2 6s1.79 4 4 4c.59 0 1.14-.13 1.64-.36L10 12l-2.36 2.36C7.14 14.13 6.59 14 6 14c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4c0-.59-.13-1.14-.36-1.64L12 14l7 7h3v-1L9.64 7.64zM6 8c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zm0 12c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zm6-7.5c-.28 0-.5-.22-.5-.5s.22-.5.5-.5.5.22.5.5-.22.5-.5.5zM19 3l-6 6 2 2 7-7V3h-3z",
    },
  };

  const CSS = `
    #${POPOVER_ID} {
      position: fixed;
      z-index: 100000;
      width: 340px;
      max-width: calc(100vw - 16px);
      max-height: min(360px, calc(100vh - 80px));
      display: flex;
      flex-direction: column;
      background: #fff;
      color: #1f2933;
      border: 1px solid #dfe1e5;
      border-radius: 6px;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18);
      font-size: 13px;
      line-height: 18px;
    }
    #${POPOVER_ID} .tulbelt-ch-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      border-bottom: 1px solid #dfe1e5;
      font-weight: 600;
    }
    #${POPOVER_ID} .tulbelt-ch-clear {
      border: 0;
      background: transparent;
      color: inherit;
      font: inherit;
      font-weight: 400;
      font-size: 12px;
      padding: 2px 6px;
      border-radius: 4px;
      cursor: pointer;
    }
    #${POPOVER_ID} .tulbelt-ch-clear:hover,
    #${POPOVER_ID} .tulbelt-ch-row:hover,
    #${POPOVER_ID} .tulbelt-ch-row:focus-visible {
      background: rgba(58, 69, 82, 0.08);
    }
    #${POPOVER_ID} .tulbelt-ch-list {
      list-style: none;
      margin: 0;
      padding: 4px 0;
      overflow-y: auto;
    }
    #${POPOVER_ID} .tulbelt-ch-row {
      display: flex;
      align-items: baseline;
      gap: 8px;
      width: 100%;
      padding: 4px 12px;
      border: 0;
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    #${POPOVER_ID} .tulbelt-ch-op {
      flex: 0 0 auto;
      align-self: center;
      display: flex;
      opacity: 0.6;
    }
    #${POPOVER_ID} .tulbelt-ch-op[data-op="cut"] {
      color: #b54708;
      opacity: 1;
    }
    #${POPOVER_ID} .tulbelt-ch-op svg {
      fill: currentColor;
    }
    #${POPOVER_ID} .tulbelt-ch-kind {
      flex: 0 0 auto;
      padding: 0 6px;
      border-radius: 3px;
      background: rgba(58, 69, 82, 0.1);
      font-size: 11px;
    }
    #${POPOVER_ID} .tulbelt-ch-preview {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #${POPOVER_ID} .tulbelt-ch-time {
      flex: 0 0 auto;
      font-size: 11px;
      opacity: 0.6;
    }
    #${POPOVER_ID} .tulbelt-ch-empty {
      padding: 16px 12px;
      opacity: 0.7;
    }
  `;

  let enabled = false;
  let entries = [];
  let popover = null;
  let closeTimer = 0;
  let pendingBump = null;
  // Storage writes are read-modify-write; chaining them keeps two quick copies
  // in this tab from overwriting each other.
  let writeQueue = Promise.resolve();

  // ---------- history store ----------

  function sanitize(stored) {
    if (!Array.isArray(stored)) return [];
    return stored.filter(
      (e) => e && typeof e === "object" && typeof e.text === "string" && typeof e.html === "string",
    );
  }

  function mutate(change) {
    writeQueue = writeQueue
      .then(async () => {
        const { [HISTORY_KEY]: stored } = await chrome.storage.local.get(HISTORY_KEY);
        await chrome.storage.local.set({ [HISTORY_KEY]: change(sanitize(stored)) });
      })
      // Storage is unreachable once the extension is reloaded under the page.
      .catch(() => {});
    return writeQueue;
  }

  function record(raw) {
    if (!enabled || !raw) return;
    const text = typeof raw.text === "string" ? raw.text : "";
    const html = typeof raw.html === "string" && raw.html.includes(TULIP_CLIP_ATTR) ? raw.html : "";
    if (!text.trim() && !html) return;
    if (text.length + html.length > MAX_ENTRY_CHARS) return;
    const op = raw.op === "cut" ? "cut" : "copy";
    mutate((list) => {
      // Copying the same thing again moves it to the top rather than repeating it.
      const next = [
        { at: Date.now(), op, text, html },
        ...list.filter((e) => e.text !== text || e.html !== html),
      ].slice(0, MAX_ENTRIES);
      let total = 0;
      const kept = [];
      for (const entry of next) {
        total += entry.text.length + entry.html.length;
        if (total > MAX_TOTAL_CHARS) break;
        kept.push(entry);
      }
      return kept;
    });
  }

  async function loadEntries() {
    try {
      const { [HISTORY_KEY]: stored } = await chrome.storage.local.get(HISTORY_KEY);
      entries = sanitize(stored);
    } catch (_) {
      entries = [];
    }
    if (popover) renderPopover();
  }

  function onStorageChanged(changes, area) {
    if (area !== "local" || !changes[HISTORY_KEY]) return;
    entries = sanitize(changes[HISTORY_KEY].newValue);
    if (popover) renderPopover();
  }

  // ---------- capture ----------

  function selectedText() {
    const active = document.activeElement;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
      try {
        // selectionStart throws on input types that have no text selection.
        return active.value.slice(active.selectionStart, active.selectionEnd);
      } catch (_) {
        return "";
      }
    }
    return String(document.getSelection() ?? "");
  }

  function onCopyOrCut(event) {
    let text = "";
    let html = "";
    try {
      text = event.clipboardData.getData("text/plain");
      html = event.clipboardData.getData("text/html");
    } catch (_) {}
    if (!text && !html) {
      // A handler that cancelled the event without setting data is copying by
      // some other route (the main-world half sees those); nothing to read here.
      if (event.defaultPrevented) return;
      text = selectedText();
    }
    record({ op: event.type, text, html });
  }

  function onPageWrite(event) {
    if (typeof event.detail !== "string") return;
    try {
      record(JSON.parse(event.detail));
    } catch (_) {}
  }

  const ownProto = window.Clipboard && window.Clipboard.prototype;
  let originalWriteText = null;
  let wrappedWriteText = null;

  function hookOwnWrites() {
    if (!ownProto || !ownProto.writeText || wrappedWriteText) return;
    originalWriteText = ownProto.writeText;
    wrappedWriteText = function (text, ...rest) {
      const result = originalWriteText.call(this, text, ...rest);
      Promise.resolve(result).then(
        () => record({ text: String(text) }),
        () => {},
      );
      return result;
    };
    ownProto.writeText = wrappedWriteText;
  }

  function unhookOwnWrites() {
    if (!wrappedWriteText) return;
    if (ownProto.writeText === wrappedWriteText) ownProto.writeText = originalWriteText;
    wrappedWriteText = null;
    originalWriteText = null;
  }

  // ---------- describing an entry ----------

  function describeTulip(entry) {
    let kind = "Tulip item";
    let preview = entry.text;
    try {
      const b64 = new DOMParser()
        .parseFromString(entry.html, "text/html")
        .querySelector(`[${TULIP_CLIP_ATTR}]`)
        .getAttribute(TULIP_CLIP_ATTR);
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const payload = JSON.parse(new TextDecoder().decode(bytes));
      if (typeof payload.clipboardType === "string" && payload.clipboardType) {
        kind = payload.clipboardType;
        // A "Trigger" copy carries its content under `trigger`; assume other
        // types follow suit (singular or plural) and show names when they do.
        const key = kind.charAt(0).toLowerCase() + kind.slice(1);
        const content = payload[key] ?? payload[key + "s"];
        const names = (Array.isArray(content) ? content : [content])
          .map((item) => item && item.name)
          .filter((name) => typeof name === "string" && name);
        if (names.length) preview = names.join(", ");
      }
    } catch (_) {}
    return { kind, preview };
  }

  function describe(entry) {
    const { kind, preview } = entry.html ? describeTulip(entry) : { kind: "Text", preview: entry.text };
    return { kind, preview: preview.slice(0, PREVIEW_CHARS).replace(/\s+/g, " ").trim() };
  }

  function age(at) {
    const minutes = Math.floor((Date.now() - at) / 60000);
    if (minutes < 1) return "now";
    if (minutes < 60) return `${minutes}m`;
    if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`;
    return `${Math.floor(minutes / (60 * 24))}d`;
  }

  // ---------- popover ----------

  async function copyEntry(entry, row) {
    const preview = row.querySelector(".tulbelt-ch-preview");
    try {
      const flavors = {};
      if (entry.text) flavors["text/plain"] = new Blob([entry.text], { type: "text/plain" });
      if (entry.html) flavors["text/html"] = new Blob([entry.html], { type: "text/html" });
      await navigator.clipboard.write([new ClipboardItem(flavors)]);
    } catch (_) {
      preview.textContent = "Copy failed";
      return;
    }
    preview.textContent = "Copied — paste with Ctrl+V";
    // Moving the entry to the top re-renders the list, which would wipe the
    // feedback line — so the move waits until the popover closes.
    pendingBump = entry;
    clearTimeout(closeTimer);
    closeTimer = setTimeout(closePopover, FEEDBACK_MS);
  }

  function buildRow(entry) {
    const { kind, preview } = describe(entry);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "tulbelt-ch-row";
    row.title = "Copy to clipboard";
    // Entries stored before the indicator existed have no `op`; they read as copies.
    const op = entry.op === "cut" ? "cut" : "copy";
    const opIcon = document.createElement("span");
    opIcon.className = "tulbelt-ch-op";
    opIcon.dataset.op = op;
    opIcon.title = OP_ICONS[op].label;
    opIcon.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" role="img" aria-label="${OP_ICONS[op].label}"><path d="${OP_ICONS[op].path}"></path></svg>`;
    row.appendChild(opIcon);
    for (const [className, text] of [
      ["tulbelt-ch-kind", kind],
      ["tulbelt-ch-preview", preview],
      ["tulbelt-ch-time", age(entry.at)],
    ]) {
      const span = document.createElement("span");
      span.className = className;
      span.textContent = text;
      row.appendChild(span);
    }
    row.addEventListener("click", () => copyEntry(entry, row));
    const item = document.createElement("li");
    item.appendChild(row);
    return item;
  }

  function renderPopover() {
    popover.textContent = "";

    const head = document.createElement("div");
    head.className = "tulbelt-ch-head";
    const title = document.createElement("span");
    title.textContent = LABEL;
    head.appendChild(title);
    if (entries.length) {
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "tulbelt-ch-clear";
      clear.textContent = "Clear";
      clear.addEventListener("click", () => mutate(() => []));
      head.appendChild(clear);
    }
    popover.appendChild(head);

    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "tulbelt-ch-empty";
      empty.textContent = "Nothing yet. Things you copy in Tulip will show up here.";
      popover.appendChild(empty);
      return;
    }
    const list = document.createElement("ul");
    list.className = "tulbelt-ch-list";
    for (const entry of entries) list.appendChild(buildRow(entry));
    popover.appendChild(list);
  }

  function onOutsidePointer(event) {
    if (popover.contains(event.target)) return;
    // The toolbar button toggles on its own click; closing here too would
    // immediately reopen it.
    if (event.target.closest?.(`#${BUTTON_ID}`)) return;
    closePopover();
  }

  function onKeydown(event) {
    if (event.key === "Escape") closePopover();
  }

  function openPopover(button) {
    popover = document.createElement("div");
    popover.id = POPOVER_ID;
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", LABEL);
    renderPopover();
    document.body.appendChild(popover);

    const rect = button.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - popover.offsetWidth - 8));
    popover.style.top = `${rect.bottom + 6}px`;
    popover.style.left = `${left}px`;

    document.addEventListener("mousedown", onOutsidePointer, true);
    document.addEventListener("keydown", onKeydown, true);
    window.addEventListener("resize", closePopover);
  }

  function closePopover() {
    if (!popover) return;
    clearTimeout(closeTimer);
    document.removeEventListener("mousedown", onOutsidePointer, true);
    document.removeEventListener("keydown", onKeydown, true);
    window.removeEventListener("resize", closePopover);
    popover.remove();
    popover = null;
    if (pendingBump) record({ ...pendingBump, op: "copy" });
    pendingBump = null;
  }

  // ---------- toolbar button ----------

  function findToolbarAnchor() {
    for (const selector of TOOLBAR_ANCHOR_SELECTORS) {
      const el = document.querySelector(selector);
      if (el) return { el, mode: "wrapped" };
    }
    const translation = document.querySelector(TRANSLATION_DROPDOWN_SELECTOR);
    if (translation) return { el: translation, mode: "after-translation" };
    return null;
  }

  function buildButton(anchor) {
    const btn = document.createElement("button");
    btn.id = BUTTON_ID;
    btn.className = anchor.className;
    btn.setAttribute("type", "button");
    const color = anchor.getAttribute("color");
    if (color) btn.setAttribute("color", color);
    // aria-label drives Tulip's tooltip content.
    btn.setAttribute("aria-label", LABEL);
    btn.innerHTML = CLIPBOARD_SVG;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (popover) closePopover();
      else openPopover(btn);
    });
    return btn;
  }

  // Mirror a neighboring wrapper so spacing, styled-component class hashes and
  // Tulip's tooltip hook-ups carry over. Another Tulbelt toggle's wrapper can
  // be the template, so its marker attributes are left behind — carrying them
  // over would make that toggle treat this wrapper as its own.
  function buildWrap(template, btn) {
    const wrap = document.createElement(template?.tagName || "div");
    for (const { name, value } of template?.attributes ?? []) {
      if (!name.startsWith("data-tulbelt-")) wrap.setAttribute(name, value);
    }
    wrap.appendChild(btn);
    return wrap;
  }

  function ensureButton() {
    if (document.getElementById(BUTTON_ID)) return;
    const found = findToolbarAnchor();
    if (!found) return;
    const { el: anchor, mode } = found;
    const variables = document.querySelector(VARIABLES_CLONE_SELECTOR);

    // Both placements leave Variables between this button and the anchor, which
    // is also where Variables lands if it renders after this button does.
    if (mode === "after-translation") {
      const template =
        document.querySelector("#app-editor-snapshot")?.parentElement ||
        anchor.parentElement?.querySelector("[data-istarget]");
      const wrap = buildWrap(template, buildButton(anchor));
      wrap.setAttribute("data-istarget", "true");
      const after = variables?.parentElement === anchor.parentElement ? variables : anchor;
      after.insertAdjacentElement("afterend", wrap);
      return;
    }

    const anchorWrap = anchor.parentElement;
    const row = anchorWrap?.parentElement;
    if (!row) return;
    const wrap = buildWrap(anchorWrap, buildButton(anchor));
    row.insertBefore(wrap, variables?.parentElement === row ? variables : anchorWrap);
  }

  function removeButton() {
    const btn = document.getElementById(BUTTON_ID);
    // The wrapper is always one this script built around the button.
    (btn?.parentElement ?? btn)?.remove();
  }

  function apply() {
    ensureButton();
    // The toolbar was re-rendered out from under an open popover.
    if (popover && !document.getElementById(BUTTON_ID)) closePopover();
  }

  const observer = addedNodesObserver(
    [TRANSLATION_DROPDOWN_SELECTOR, ...TOOLBAR_ANCHOR_SELECTORS].join(", "),
    apply,
  );

  registerToggle(FEATURE_ID, {
    onEnable() {
      enabled = true;
      document.documentElement.setAttribute(ENABLED_ATTR, "true");
      ensureStyles(STYLE_ID, CSS);
      chrome.storage.onChanged.addListener(onStorageChanged);
      loadEntries();
      window.addEventListener("copy", onCopyOrCut);
      window.addEventListener("cut", onCopyOrCut);
      document.addEventListener(COPY_EVENT, onPageWrite);
      hookOwnWrites();
      apply();
      observer.start();
    },
    onDisable() {
      enabled = false;
      observer.stop();
      document.documentElement.removeAttribute(ENABLED_ATTR);
      chrome.storage.onChanged.removeListener(onStorageChanged);
      window.removeEventListener("copy", onCopyOrCut);
      window.removeEventListener("cut", onCopyOrCut);
      document.removeEventListener(COPY_EVENT, onPageWrite);
      unhookOwnWrites();
      closePopover();
      removeButton();
      removeStyles(STYLE_ID);
    },
  });
})();
