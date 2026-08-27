// Trigger-editor Value Picker inputs (`input[aria-label="Value Picker"]`) are
// one fixed-width line, so long static values get clipped. When a value
// overflows its box, this hides the input (and its fixed-35px-height wrapper,
// which would otherwise clip anything taller — the action-editor-frequent.js
// hidden-real + proxy pattern) and renders a soft-wrapping, auto-growing
// <textarea> proxy on its own line below the row of selects, stretched to the
// row's width. Keystrokes forward into the real input via the native value
// setter + bubbling input/change events (the snap-to-grid.js pattern) so
// React state stays the source of truth.
//
// Swaps in either direction happen only on mount/reconcile and on blur, never
// while the field is focused, so the caret is never yanked mid-typing. Enter
// commits (forwarded to the real input) instead of inserting a newline —
// input[type=text] values can't contain line breaks; the multiline look is
// soft wrap only.

(() => {
  const { registerToggle, ensureStyles, removeStyles } = window.__tulbeltLib;

  const FEATURE_ID = "trigger-value-full-text";

  const INPUT_SEL = 'input[type="text"][aria-label="Value Picker"]';
  // Tulip's trigger-editor CSS-module class prefix; keeps look-alike inputs
  // elsewhere untouched.
  const EDITOR_SCOPE_SEL = '[class*="triggers-editor-client"]';
  // The selects+input row the proxy is placed after ("Static value", "Text",
  // …). Distinct from the inner "triggerItemStyles" containers.
  const UNIT_SEL = '[class*="triggerUnitStyles"]';
  const PROXY_ATTR = "data-tulbelt-fulltext-proxy";
  const HIDDEN_ATTR = "data-tulbelt-fulltext-hidden";
  const STYLE_ID = "tulbelt-trigger-value-full-text-styles";

  let active = false;
  let observer = null;
  // real input -> proxy textarea and back. WeakMaps so React-replaced inputs
  // are auto-collected; reset wholesale on disable.
  let tracked = new WeakMap();
  let proxyToInput = new WeakMap();

  const CSS = `
      /* Hide the input's wrapper, not just the input — the wrapper keeps a
         fixed 35px x ~175px footprint that would leave an empty gap in the
         selects row. */
      :has(> input[${HIDDEN_ATTR}="true"]) { display: none !important; }
      textarea[${PROXY_ATTR}] {
        field-sizing: content;
        resize: none;
        overflow: hidden;
        box-sizing: border-box;
        display: block;
        white-space: pre-wrap;
        overflow-wrap: break-word;
        /* The action body is a wrapping row flexbox. flex-basis:auto keeps
           the proxy's natural (one-line text) width as its hypothetical size,
           so flexbox puts it beside the selects while the text fits in the
           leftover space and wraps it to a new line only when it doesn't.
           grow stays 0 so the box always hugs its text — it only reaches full
           width when the text is longer than the row, where shrink +
           min-width:0 compress it to the row width and the text soft-wraps
           onto 2+ lines. */
        flex: 0 1 auto;
        min-width: 0;
        margin: 0;
      }
    `;

  function isValuePickerInput(el) {
    return (
      el instanceof HTMLInputElement && el.matches(INPUT_SEL) && !!el.closest(EDITOR_SCOPE_SEL)
    );
  }

  // Drive React's onChange by going around the React-overridden value setter.
  function setNativeInputValue(input, value) {
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    desc.set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // scrollWidth/clientWidth are 0 while the input's wrapper is display:none,
  // so a proxied input is measured by synchronously unhiding it — no paint
  // happens between the attribute flips, so nothing flickers.
  function overflows(input) {
    const hidden = input.getAttribute(HIDDEN_ATTR) === "true";
    if (hidden) input.removeAttribute(HIDDEN_ATTR);
    const result = input.scrollWidth > input.clientWidth + 1;
    if (hidden) input.setAttribute(HIDDEN_ATTR, "true");
    return result;
  }

  // The input carries no class (its look lives in computed styles), so the
  // proxy copies the visual properties directly. Width comes from
  // `align-self: stretch` in the injected stylesheet — the proxy fills the
  // action body rather than keeping the input's narrow fixed width.
  const COPIED_STYLES = [
    "font",
    "letterSpacing",
    "color",
    "backgroundColor",
    "border",
    "borderRadius",
    "padding",
    "boxShadow",
    "lineHeight",
    "textAlign",
  ];

  // The proxy lives after the whole selects+input unit row, so the expanded
  // box gets its own full-width line instead of squeezing into the row.
  function proxyAnchor(input) {
    const unit = input.closest(UNIT_SEL);
    return unit?.parentElement ? unit : null;
  }

  function mountProxy(input) {
    if (tracked.has(input)) return;
    const anchor = proxyAnchor(input);
    if (!anchor) return;

    const proxy = document.createElement("textarea");
    proxy.setAttribute(PROXY_ATTR, "1");
    proxy.rows = 1;
    proxy.wrap = "soft";
    const aria = input.getAttribute("aria-label");
    if (aria) proxy.setAttribute("aria-label", aria);
    proxy.placeholder = input.placeholder || "";

    // Capture while the real input is still visible.
    const cs = getComputedStyle(input);
    for (const prop of COPIED_STYLES) proxy.style[prop] = cs[prop];
    proxy.style.minHeight = cs.height;
    // An <input> vertically centers its single line inside its height; a
    // textarea top-aligns. With the input's own 6px padding, one 17.5px line
    // comes to ~31px, so the 35px min-height leaves slack at the bottom and
    // the text sits visibly high. Split that slack into the vertical padding
    // so a single line is centered at exactly min-height and extra lines grow
    // from there.
    const lineH = parseFloat(cs.lineHeight);
    const inputH = parseFloat(cs.height);
    const borderY = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    if (Number.isFinite(lineH) && Number.isFinite(inputH)) {
      const pad = (inputH - lineH - borderY) / 2;
      if (pad > 0) {
        proxy.style.paddingTop = `${pad}px`;
        proxy.style.paddingBottom = `${pad}px`;
      }
    }
    proxy.value = input.value;

    proxy.addEventListener("input", () => {
      // Pasted newlines are flattened — the real input's value can't hold them.
      const flat = proxy.value.replace(/[\r\n]+/g, " ");
      if (flat !== proxy.value) proxy.value = flat;
      setNativeInputValue(input, flat);
    });

    proxy.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const enter = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true };
      input.dispatchEvent(new KeyboardEvent("keydown", enter));
      input.dispatchEvent(new KeyboardEvent("keyup", enter));
      proxy.blur();
    });

    // field-sizing: content handles auto-grow on Chrome 123+; fall back to a
    // scrollHeight resize for older builds. window.CSS — the file-scoped CSS
    // string above shadows the global.
    if (!window.CSS.supports("field-sizing", "content")) {
      const grow = () => {
        proxy.style.height = "auto";
        proxy.style.height = `${proxy.scrollHeight}px`;
      };
      proxy.addEventListener("input", grow);
      queueMicrotask(grow);
    }

    anchor.parentElement.insertBefore(proxy, anchor.nextSibling);
    input.setAttribute(HIDDEN_ATTR, "true");
    tracked.set(input, proxy);
    proxyToInput.set(proxy, input);
  }

  function unmountProxy(input) {
    const proxy = tracked.get(input);
    if (proxy) proxyToInput.delete(proxy);
    proxy?.remove();
    tracked.delete(input);
    input.removeAttribute(HIDDEN_ATTR);
  }

  function isFocused(el) {
    return document.activeElement === el;
  }

  // Decide native-vs-proxy for one input. Never flips state while the input
  // or its proxy is focused.
  function evaluate(input) {
    if (!input.isConnected) return;
    const proxy = tracked.get(input);
    if (proxy) {
      if (isFocused(proxy)) return;
      // React may have changed the value or rebuilt siblings underneath us.
      if (proxy.value !== input.value) proxy.value = input.value;
      const anchor = proxyAnchor(input);
      if (!anchor) {
        unmountProxy(input);
        return;
      }
      if (!proxy.isConnected || anchor.nextElementSibling !== proxy) {
        anchor.parentElement.insertBefore(proxy, anchor.nextSibling);
      }
      if (input.getAttribute(HIDDEN_ATTR) !== "true") {
        input.setAttribute(HIDDEN_ATTR, "true");
      }
      if (!overflows(input)) unmountProxy(input);
    } else {
      if (isFocused(input)) return;
      if (overflows(input)) mountProxy(input);
    }
  }

  function reconcile() {
    // Proxies whose input React removed (row deleted, action type changed)
    // aren't reachable through the WeakMap — sweep them by attribute.
    for (const proxy of document.querySelectorAll(`textarea[${PROXY_ATTR}]`)) {
      const input = proxyToInput.get(proxy);
      if (!input || !input.isConnected) proxy.remove();
    }
    for (const input of document.querySelectorAll(INPUT_SEL)) {
      if (isValuePickerInput(input)) evaluate(input);
    }
  }

  function restoreAll() {
    document.querySelectorAll(`[${PROXY_ATTR}]`).forEach((el) => el.remove());
    document
      .querySelectorAll(`[${HIDDEN_ATTR}="true"]`)
      .forEach((el) => el.removeAttribute(HIDDEN_ATTR));
    tracked = new WeakMap();
    proxyToInput = new WeakMap();
  }

  // Re-evaluate on blur — the only moment state is allowed to flip for a
  // field the user was just editing. focusout is delegated so per-input
  // listeners aren't needed.
  function onFocusOut(e) {
    const t = e.target;
    let input = null;
    if (t instanceof Element && t.hasAttribute?.(PROXY_ATTR)) {
      input = proxyToInput.get(t);
    } else if (isValuePickerInput(t)) {
      input = t;
    }
    if (!(input instanceof HTMLInputElement)) return;
    // Wait a tick so document.activeElement reflects where focus landed.
    setTimeout(() => {
      if (active) evaluate(input);
    }, 0);
  }

  function mutationTouchesTarget(node) {
    if (!(node instanceof Element)) return false;
    if (node.hasAttribute?.(PROXY_ATTR)) return false;
    return node.matches?.(INPUT_SEL) || !!node.querySelector?.(INPUT_SEL);
  }

  function onMutation(mutations) {
    let needsReconcile = false;
    for (const m of mutations) {
      if (m.target instanceof Element && m.target.closest?.(`[${PROXY_ATTR}]`)) continue;
      for (const node of m.addedNodes) {
        if (mutationTouchesTarget(node)) needsReconcile = true;
      }
      for (const node of m.removedNodes) {
        if (!(node instanceof Element)) continue;
        // A removed row takes its input with it but can leave the proxy
        // sibling behind; reconcile sweeps orphans.
        if (tracked.has(node) || node.querySelector?.(`[${PROXY_ATTR}]`) || node.querySelector?.(INPUT_SEL)) {
          needsReconcile = true;
        }
      }
    }
    if (needsReconcile) reconcile();
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(onMutation);
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("focusout", onFocusOut, true);
  }

  function stopObserver() {
    observer?.disconnect();
    observer = null;
    document.removeEventListener("focusout", onFocusOut, true);
  }

  registerToggle(FEATURE_ID, {
    onEnable() {
      active = true;
      ensureStyles(STYLE_ID, CSS);
      reconcile();
      startObserver();
    },
    onDisable() {
      active = false;
      stopObserver();
      restoreAll();
      removeStyles(STYLE_ID);
    },
  });
})();
