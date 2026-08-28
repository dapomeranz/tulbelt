// The trigger action-type picker (`select[data-testid$="action-editor"]`) lists
// every action alphabetically. This collapses the list to four frequent actions
// plus a "Show all actions…" sentinel option. Expanding to the full list has
// two routes: an "All…" button next to the select (one click — its DOM click
// carries transient activation, so a synchronous showPicker() opens the full
// list immediately), and the in-dropdown sentinel as a discoverable fallback
// (clicks inside a native select popup happen in browser chrome and grant the
// page no activation, so that route can't reopen the picker for mouse users —
// the list just stays expanded for the next click).
//
// The select is React-controlled, so we don't reorder its own nodes (React keeps
// re-rendering and scrambling our order back). Instead — the filters-builder.js
// pattern — we hide the real select and render a sibling proxy <select> we fully
// own. On change we forward the chosen value into the real select via the native
// value setter + a bubbling `change` event so React's onChange fires as usual.
// Frequent actions are matched by label text (option `value`s are random
// per-instance IDs).

(() => {
  const { registerToggle, ensureStyles, removeStyles } = window.__tulbeltLib;

  const FEATURE_ID = "action-editor-frequent";

  const SELECT_SEL = 'select[data-testid$="action-editor"]';
  const PROXY_ATTR = "data-tulbelt-frequent-proxy";
  const EXPAND_ATTR = "data-tulbelt-frequent-expand";
  const HIDDEN_ATTR = "data-tulbelt-frequent-hidden";
  const STYLE_ID = "tulbelt-frequent-actions-styles";

  // Frequent action labels, in the order they should appear at the top.
  const FREQUENT = ["Data Manipulation", "Table Records", "Run Function", "Run Connector Function"];

  // Sentinel option that expands the collapsed proxy to the full action list.
  // Real option values are random per-instance IDs, so this can't collide.
  const SENTINEL_VALUE = "__tulbelt-show-all__";
  const SENTINEL_LABEL = "Show all actions…";

  let observer = null;
  // real select -> { proxy, signature }. WeakMap so React-replaced selects are
  // auto-collected; reset wholesale on disable.
  let tracked = new WeakMap();

  // Drive React's onChange by going around the React-overridden value setter.
  function setNativeSelectValue(select, value) {
    const proto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
    proto.set.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // A label-based signature of the real option set, to detect when React rebuilds
  // the options (add/remove action types) and the proxy needs rebuilding.
  function optionsSignature(select) {
    return Array.from(select.options)
      .map((o) => `${o.value}\u0000${o.textContent.trim()}`)
      .join("\u0001");
  }

  function cloneOption(opt) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.textContent;
    if (opt.disabled) o.disabled = true;
    return o;
  }

  function buildProxyOptions(proxy, real, expanded) {
    proxy.replaceChildren();
    const opts = Array.from(real.options);

    // First option with a given label wins for the frequent lookup.
    const byLabel = new Map();
    for (const o of opts) {
      const label = o.textContent.trim();
      if (!byLabel.has(label)) byLabel.set(label, o);
    }

    // The blank-label placeholder stays first so the unselected state works.
    const placeholder = opts.find((o) => o.textContent.trim() === "");

    const frequentOpts = [];
    for (const label of FREQUENT) {
      const o = byLabel.get(label);
      if (o) frequentOpts.push(o);
    }
    const frequentSet = new Set(frequentOpts);

    // Placeholder, then the frequent actions.
    if (placeholder) proxy.appendChild(cloneOption(placeholder));
    for (const o of frequentOpts) proxy.appendChild(cloneOption(o));

    if (expanded) {
      // Everything else in its original order.
      for (const o of opts) {
        if (o !== placeholder && !frequentSet.has(o)) {
          proxy.appendChild(cloneOption(o));
        }
      }
    } else {
      // Keep the real select's current choice visible when it isn't frequent
      // (e.g. editing an existing trigger), then the expand sentinel.
      const current = opts.find((o) => o.value === real.value);
      if (current && current !== placeholder && !frequentSet.has(current)) {
        proxy.appendChild(cloneOption(current));
      }
      const more = document.createElement("option");
      more.value = SENTINEL_VALUE;
      more.textContent = SENTINEL_LABEL;
      proxy.appendChild(more);
    }

    proxy.value = real.value;
  }

  function hasFrequentOption(real) {
    return FREQUENT.some((label) =>
      Array.from(real.options).some((o) => o.textContent.trim() === label),
    );
  }

  // The button only earns its space while the list is collapsed; once expanded
  // the dropdown itself holds everything.
  function syncExpandButton(entry) {
    entry.button.style.display = entry.expanded ? "none" : "";
  }

  function attach(real) {
    const existing = tracked.get(real);
    if (existing) {
      if (real.getAttribute(HIDDEN_ATTR) !== "true") {
        real.setAttribute(HIDDEN_ATTR, "true");
      }
      if (!existing.proxy.isConnected || real.nextElementSibling !== existing.proxy) {
        real.parentElement?.insertBefore(existing.proxy, real.nextSibling);
      }
      if (!existing.button.isConnected || existing.proxy.nextElementSibling !== existing.button) {
        existing.proxy.after(existing.button);
      }
      // Track the real select's (stateful) styled-component class so validation
      // styling like the empty/required red border stays in step.
      if (existing.proxy.className !== real.className) {
        existing.proxy.className = real.className;
      }
      const sig = optionsSignature(real);
      if (existing.signature !== sig) {
        existing.expanded = false;
        buildProxyOptions(existing.proxy, real, existing.expanded);
        existing.signature = sig;
        syncExpandButton(existing);
      } else if (existing.proxy.value !== real.value) {
        // Rebuild rather than just assign: a collapsed proxy may not contain
        // the real select's new value.
        buildProxyOptions(existing.proxy, real, existing.expanded);
      }
      return;
    }

    if (!real.parentElement || !hasFrequentOption(real)) return;

    const proxy = document.createElement("select");
    proxy.setAttribute(PROXY_ATTR, "1");
    proxy.className = real.className;
    const aria = real.getAttribute("aria-label");
    if (aria) proxy.setAttribute("aria-label", aria);
    const inlineStyle = real.getAttribute("style");
    if (inlineStyle) proxy.setAttribute("style", inlineStyle);

    // The real select sits in a segmented-group container (`.HQmsw`) that
    // collapses shared borders via positional rules (`:first-child`,
    // `:last-child`, `:not(:first-child)`). The hidden real select still counts
    // for those pseudo-classes, so the proxy lands in a different slot and loses
    // its left border + corner radii (the "shifted left" look). Restore only that
    // left-side geometry inline (inline beats the class rules), mirroring the
    // untouched right side. Crucially we do NOT pin border color/style here — the
    // select's color is a stateful, styled-component value (e.g. the red
    // required/empty variant) that lives on its className, so freezing it would
    // strand the proxy in whatever state it had at creation. Let it ride the
    // className instead (kept in sync below). Capture while the real select is
    // still visible, before we hide it.
    const cs = getComputedStyle(real);
    proxy.style.borderLeftWidth = cs.borderRightWidth;
    proxy.style.borderTopLeftRadius = cs.borderTopRightRadius;
    proxy.style.borderBottomLeftRadius = cs.borderBottomRightRadius;

    buildProxyOptions(proxy, real, false);
    proxy.addEventListener("change", () => {
      if (proxy.value === SENTINEL_VALUE) {
        const entry = tracked.get(real);
        if (entry) {
          entry.expanded = true;
          syncExpandButton(entry);
        }
        buildProxyOptions(proxy, real, true);
        // Mouse picks happen in browser chrome and grant no transient
        // activation, so this reopen only ever works for keyboard picks —
        // otherwise the list at least stays expanded for the next click.
        setTimeout(() => {
          try {
            proxy.showPicker();
          } catch (e) {
            console.warn("[tulbelt] reopen after expand failed:", e.message);
          }
        }, 0);
        return;
      }
      setNativeSelectValue(real, proxy.value);
      // React re-renders the real select after the value change, which may swap
      // its validation class (e.g. drop the empty/required red border). Mirror it
      // once that has settled so the proxy doesn't stay stuck on the old state.
      Promise.resolve().then(() => {
        if (proxy.className !== real.className) proxy.className = real.className;
      });
    });

    const expand = document.createElement("button");
    expand.type = "button";
    expand.setAttribute(EXPAND_ATTR, "1");
    expand.textContent = "All…";
    expand.title = "Show all actions";
    expand.setAttribute("aria-label", "Show all actions");
    expand.addEventListener("click", () => {
      const entry = tracked.get(real);
      if (!entry) return;
      entry.expanded = true;
      buildProxyOptions(proxy, real, true);
      syncExpandButton(entry);
      proxy.focus();
      // Unlike the sentinel path, this click is a real DOM event with
      // transient activation, so a synchronous showPicker() is allowed.
      try {
        proxy.showPicker();
      } catch (e) {
        console.warn("[tulbelt] showPicker after expand failed:", e.message);
      }
    });

    real.parentElement.insertBefore(proxy, real.nextSibling);
    proxy.after(expand);
    real.setAttribute(HIDDEN_ATTR, "true");

    tracked.set(real, {
      proxy,
      button: expand,
      signature: optionsSignature(real),
      expanded: false,
    });
  }

  function reconcile() {
    for (const real of document.querySelectorAll(SELECT_SEL)) {
      attach(real);
    }
  }

  function restoreAll() {
    document.querySelectorAll(`[${PROXY_ATTR}], [${EXPAND_ATTR}]`).forEach((el) => el.remove());
    document
      .querySelectorAll(`[${HIDDEN_ATTR}="true"]`)
      .forEach((el) => el.removeAttribute(HIDDEN_ATTR));
    tracked = new WeakMap();
  }

  function mutationTouchesTarget(node) {
    if (!(node instanceof Element)) return false;
    if (node.hasAttribute?.(PROXY_ATTR)) return false;
    return node.matches?.(SELECT_SEL) || !!node.querySelector?.(SELECT_SEL);
  }

  function onMutation(mutations) {
    let needsReconcile = false;
    for (const m of mutations) {
      // Ignore mutations inside our own proxy or expand button.
      if (m.target instanceof Element && m.target.closest?.(`[${PROXY_ATTR}], [${EXPAND_ATTR}]`)) {
        continue;
      }
      // Option set changed on a tracked real select, or React swapped its
      // validity styling class in place.
      if (m.target instanceof Element && tracked.has(m.target)) {
        needsReconcile = true;
      }
      for (const node of m.addedNodes) {
        if (mutationTouchesTarget(node)) needsReconcile = true;
      }
      for (const node of m.removedNodes) {
        if (node instanceof Element && tracked.has(node)) {
          const entry = tracked.get(node);
          entry?.proxy.remove();
          entry?.button.remove();
          tracked.delete(node);
        }
      }
    }
    if (needsReconcile) reconcile();
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(onMutation);
    // attributeFilter: React flips validity styling by rewriting class on the
    // real select in place — a childList-only observer never sees that.
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
    });
  }

  function stopObserver() {
    observer?.disconnect();
    observer = null;
  }

  registerToggle(FEATURE_ID, {
    onEnable() {
      ensureStyles(
        STYLE_ID,
        `[${HIDDEN_ATTR}="true"] { display: none !important; }
         button[${EXPAND_ATTR}] {
           margin-left: 5px; padding: 0 10px; min-height: 35px; font: inherit;
           background: #fff; color: #333; border: 1px solid #ccc;
           border-radius: 3px; cursor: pointer; white-space: nowrap;
         }
         button[${EXPAND_ATTR}]:hover { background: #f2f5f9; }`,
      );
      reconcile();
      startObserver();
    },
    onDisable() {
      stopObserver();
      restoreAll();
      removeStyles(STYLE_ID);
    },
  });
})();
