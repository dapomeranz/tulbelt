// Use side of option-sets-builder: pick a configured option set instead of
// typing a static value in trigger editors.
//
// Every "Select source of data" dropdown (data-testid="datasource-selector")
// is proxied — real select hidden, visually identical proxy shown — with one
// extra entry, "Option Set". Picking it silently drives the real controls to
// Static value, shows a set picker and an option picker, and on option pick
// writes the set's data type into the type select and the option's value into
// the value input (native value setter + bubbled events, the same write-back
// pattern as trigger-value-full-text). Rows whose Static value renders with
// no data type select (some action parameters, e.g. Path) get only the value
// write. The pickers are a transient authoring
// aid: once the value is written, they disappear and the row is exactly the
// manual Static value entry Tulip would have produced — Tulip never sees
// anything else. There is deliberately no reverse flow (existing static
// values are never re-displayed as option sets).
//
// Option sets are read from the tenant origin's localStorage key
// `tulbelt-option-sets`, written by the builder page (option-sets-builder.js).
// Both scripts share the `option-sets-builder` feature toggle.

(() => {
  const { registerToggle, ensureStyles, removeStyles } = window.__tulbeltLib;

  const FEATURE_ID = "option-sets-builder";
  const LS_KEY = "tulbelt-option-sets";

  const DS_SELECT = 'select[data-testid="datasource-selector"]';
  const TYPE_SELECT = 'select[data-testid="type-static-value-specifier"]';
  const VALUE_INPUT = 'input[data-testid="value-static-value-specifier"]';

  const REAL_ATTR = "data-tulbelt-oss-real";
  const PROXY_ATTR = "data-tulbelt-oss-proxy";
  const PICKER_ATTR = "data-tulbelt-oss-picker";
  const FLOW_ATTR = "data-tulbelt-oss-flow";
  const STYLE_ID = "tulbelt-oss-styles";
  const SENTINEL = "__tulbelt-option-set__";

  const TYPE_LABELS = { text: "Text", integer: "Integer", number: "Number" };

  let active = false;
  let observer = null;
  let scheduled = false;
  // real datasource <select> -> { proxy, container, setId }
  const flows = new WeakMap();

  // ── Option set data ─────────────────────────────────────────────────────────

  function loadSets() {
    try {
      const parsed = JSON.parse(localStorage.getItem(LS_KEY) || "null");
      return Array.isArray(parsed?.sets) ? parsed.sets : [];
    } catch (_) {
      return [];
    }
  }

  function valueValid(type, raw) {
    const s = String(raw).trim();
    if (s === "") return false;
    if (type === "integer") return /^-?\d+$/.test(s);
    if (type === "number") return Number.isFinite(Number(s));
    return true;
  }

  // ── React write-back ────────────────────────────────────────────────────────

  function setNativeSelect(select, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setNativeInput(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function findOptionByText(select, text) {
    return [...select.options].find((o) => o.textContent.trim() === text) || null;
  }

  // Poll until fn() is truthy (React renders the next control) or time out.
  function waitFor(fn, timeout = 3000) {
    return new Promise((resolve) => {
      const deadline = performance.now() + timeout;
      const tick = () => {
        const result = fn();
        if (result) return resolve(result);
        if (performance.now() > deadline) return resolve(null);
        requestAnimationFrame(tick);
      };
      tick();
    });
  }

  // ── Styles ──────────────────────────────────────────────────────────────────

  // While a flow is active, hide the row's static type/value controls
  // (rendered asynchronously after we select Static value) — but never the
  // sibling div holding the datasource selector and our pickers.
  const CSS = `
      ${DS_SELECT}[${REAL_ATTR}] { display: none !important; }
      [${FLOW_ATTR}] div.imports-triggers-editor-client-styles--triggerItemStyles:not(:has(${DS_SELECT})) { display: none !important; }
      select[${PICKER_ATTR}] { margin-left: 5px; max-width: 240px; }
      button[${PICKER_ATTR}] {
        margin-left: 5px; padding: 0 12px; min-height: 35px; font: inherit;
        background: #1c69e1; color: #fff; border: none; border-radius: 3px; cursor: pointer;
      }
    `;

  // ── Proxy lifecycle ─────────────────────────────────────────────────────────

  function containerFor(real) {
    return real.closest('[data-testid^="value-specifier-selector"]') || real.parentElement;
  }

  // Tulip's segmented-group container collapses shared select borders with
  // positional rules (:first-child / :not(:first-child)). The hidden real
  // select still occupies its first-child slot, so anything we insert after it
  // renders as a middle element — no left border or corner radii, sitting a
  // few pixels left (the action-editor-frequent.js fix). Mirror the untouched
  // right side inline; `cs` must be captured from a still-visible select.
  function restoreLeftEdge(el, cs) {
    el.style.borderLeftWidth = cs.borderRightWidth;
    el.style.borderTopLeftRadius = cs.borderTopRightRadius;
    el.style.borderBottomLeftRadius = cs.borderBottomRightRadius;
  }

  function buildProxy(real) {
    const proxy = document.createElement("select");
    proxy.setAttribute(PROXY_ATTR, "1");
    proxy.className = real.className;
    proxy.setAttribute("aria-label", real.getAttribute("aria-label") || "Select source of data");
    let staticOption = null;
    for (const opt of real.options) {
      const copy = document.createElement("option");
      copy.value = opt.value;
      copy.textContent = opt.textContent;
      if (opt.textContent.trim() === "Static value") staticOption = copy;
      proxy.appendChild(copy);
    }
    const sentinel = document.createElement("option");
    sentinel.value = SENTINEL;
    sentinel.textContent = "Option Set";
    // Conceptually (and near-alphabetically) it belongs next to Static value.
    if (staticOption) staticOption.before(sentinel);
    else proxy.appendChild(sentinel);
    restoreLeftEdge(proxy, getComputedStyle(real));
    proxy.value = real.value;
    proxy._ossReal = real;
    proxy.addEventListener("change", () => onProxyChange(real, proxy));
    return proxy;
  }

  function onProxyChange(real, proxy) {
    if (proxy.value === SENTINEL) {
      startFlow(real, proxy);
      return;
    }
    // Write-through must precede endFlow: endFlow re-syncs proxy.value from
    // real.value, so running it first clobbers the pick with the stale value
    // and the selection becomes a no-op.
    setNativeSelect(real, proxy.value);
    endFlow(real, proxy);
  }

  function removePickers(container) {
    for (const el of container.querySelectorAll(`[${PICKER_ATTR}]`)) el.remove();
  }

  function endFlow(real, proxy) {
    const flow = flows.get(real);
    flows.delete(real);
    const container = flow?.container || containerFor(real);
    if (container) {
      container.removeAttribute(FLOW_ATTR);
      removePickers(container);
    }
    if (proxy?.isConnected) proxy.value = real.value;
  }

  // ── The flow: Option Set → set → option → write-through ─────────────────────

  function startFlow(real, proxy) {
    const container = containerFor(real);
    if (!container) return;
    flows.set(real, { proxy, container, setId: null });
    container.setAttribute(FLOW_ATTR, "");
    removePickers(container);

    // Silently put the real row into Static value mode; the type/value
    // controls it renders stay hidden by the flow CSS until we're done.
    const staticOpt = findOptionByText(real, "Static value");
    if (staticOpt && real.value !== staticOpt.value) setNativeSelect(real, staticOpt.value);

    const sets = loadSets();
    if (sets.length === 0) {
      // Nothing to pick from — offer the builder page instead. It survives a
      // cold load of the fake URL, so a new tab works.
      const configure = document.createElement("button");
      configure.type = "button";
      configure.setAttribute(PICKER_ATTR, "configure");
      configure.textContent = "No option sets yet — configure…";
      configure.title = "Opens Tulbelt's Option Sets page in a new tab (also in the account menu)";
      configure.addEventListener("click", () => {
        window.open("/tulbelt/option-sets", "_blank");
      });
      proxy.after(configure);
      return;
    }

    const setPicker = document.createElement("select");
    setPicker.setAttribute(PICKER_ATTR, "set");
    setPicker.className = real.className;
    restoreLeftEdge(setPicker, getComputedStyle(proxy));
    setPicker.setAttribute("aria-label", "Select option set");
    {
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Choose option set…";
      placeholder.disabled = true;
      placeholder.selected = true;
      setPicker.appendChild(placeholder);
      for (const set of sets) {
        const opt = document.createElement("option");
        opt.value = set.id;
        opt.textContent = `${set.name} (${TYPE_LABELS[set.dataType] || set.dataType})`;
        if (set.description) opt.title = set.description;
        setPicker.appendChild(opt);
      }
    }
    setPicker.addEventListener("change", () => onSetPicked(real, setPicker.value));
    proxy.after(setPicker);
  }

  function onSetPicked(real, setId) {
    const flow = flows.get(real);
    if (!flow) return;
    flow.setId = setId;
    const set = loadSets().find((s) => s.id === setId);
    if (!set) return;

    flow.container.querySelector(`select[${PICKER_ATTR}="option"]`)?.remove();
    const optionPicker = document.createElement("select");
    optionPicker.setAttribute(PICKER_ATTR, "option");
    optionPicker.className = real.className;
    restoreLeftEdge(optionPicker, getComputedStyle(flow.proxy));
    optionPicker.setAttribute("aria-label", "Select option");
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Choose option…";
    placeholder.disabled = true;
    placeholder.selected = true;
    optionPicker.appendChild(placeholder);
    const valid = set.options.filter((o) => valueValid(set.dataType, o.value));
    for (const option of valid) {
      const opt = document.createElement("option");
      opt.value = option.id;
      opt.textContent = option.value;
      if (option.description) opt.title = option.description;
      optionPicker.appendChild(opt);
    }
    if (valid.length === 0) {
      placeholder.textContent = "This set has no valid options";
    }
    optionPicker.addEventListener("change", () => onOptionPicked(real, set.id, optionPicker.value));
    flow.container.querySelector(`select[${PICKER_ATTR}="set"]`)?.after(optionPicker);
  }

  function frames(n) {
    return new Promise((resolve) => {
      const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step));
      step();
    });
  }

  // Write the value and verify it survived. The type-select change we just
  // dispatched makes React re-render the row — a single write can land on a
  // node React is about to discard, or be cleared by a type-change effect
  // right after. Controlled inputs snap back to React state on unaccepted
  // writes, so "DOM still holds the value a few frames later" proves state
  // took it; if it was clobbered, re-query (the node may have been remounted)
  // and write again. The input is focused first and blurred after so any
  // commit-on-blur handling Tulip has fires exactly as it would for manual
  // entry — callers must run this only after the flow CSS unhides the input,
  // since a display:none input silently refuses focus().
  async function writeValueWithRetry(container, value, attempts = 6) {
    for (let i = 0; i < attempts; i++) {
      if (!container.isConnected) {
        console.warn("[tulbelt] option-sets: row was replaced mid-write — aborting");
        return false;
      }
      const input = await waitFor(() => container.querySelector(VALUE_INPUT), 1000);
      if (!input) return false;
      input.focus({ preventScroll: true });
      setNativeInput(input, value);
      await frames(3);
      const now = container.querySelector(VALUE_INPUT);
      if (now && now.value === value) {
        now.blur();
        return true;
      }
      console.warn(`[tulbelt] option-sets: value write clobbered by a re-render (attempt ${i + 1}) — retrying`);
    }
    return false;
  }

  async function onOptionPicked(real, setId, optionId) {
    const flow = flows.get(real);
    if (!flow) return;
    const set = loadSets().find((s) => s.id === setId);
    const option = set?.options.find((o) => o.id === optionId);
    if (!set || !option) return;
    const { container, proxy } = flow;

    // Static value should already be selected; make sure before driving on.
    const staticOpt = findOptionByText(real, "Static value");
    if (staticOpt && real.value !== staticOpt.value) setNativeSelect(real, staticOpt.value);

    // Some rows render Static value as a bare value input with no data type
    // select (e.g. an action's Path parameter). Wait for whichever control
    // appears; both render in the same commit, so a value input with no type
    // select beside it means a typeless row — skip the type write entirely.
    const anyControl = await waitFor(
      () => container.querySelector(TYPE_SELECT) || container.querySelector(VALUE_INPUT)
    );
    if (!anyControl) {
      console.warn("[tulbelt] option-sets: static value controls never rendered — aborting");
      endFlow(real, proxy);
      return;
    }
    const typeSelect = container.querySelector(TYPE_SELECT);
    if (typeSelect) {
      const typeOpt = findOptionByText(typeSelect, TYPE_LABELS[set.dataType] || "");
      if (typeOpt && typeSelect.value !== typeOpt.value) {
        setNativeSelect(typeSelect, typeOpt.value);
        // Let React finish committing the type change before touching the input.
        await frames(2);
      }
    }

    // Drop the pickers and unhide the native controls BEFORE writing: the
    // value write needs a visible, focusable input (see writeValueWithRetry).
    endFlow(real, proxy);

    const ok = await writeValueWithRetry(container, String(option.value));
    if (!ok) {
      console.warn("[tulbelt] option-sets: value write never stuck — Tulip UI may have changed");
    }
  }

  // ── Scan loop ───────────────────────────────────────────────────────────────

  function ensureAll() {
    // Remove proxies whose real select was swept away by a React re-render.
    for (const proxy of document.querySelectorAll(`select[${PROXY_ATTR}]`)) {
      const real = proxy._ossReal;
      if (!real || !real.isConnected) {
        proxy.closest(`[${FLOW_ATTR}]`)?.removeAttribute(FLOW_ATTR);
        for (const p of proxy.parentElement?.querySelectorAll(`[${PICKER_ATTR}]`) || []) p.remove();
        proxy.remove();
      }
    }
    for (const real of document.querySelectorAll(DS_SELECT)) {
      const existing = real.nextElementSibling?.hasAttribute?.(PROXY_ATTR)
        ? real.nextElementSibling
        : null;
      if (!existing) {
        // Only proxy dropdowns that can express the result. The flow writes
        // through Static value, so a datasource list without that entry
        // (some fields only accept Variable/Users-style sources) could never
        // complete it — leave the native select alone.
        if (!findOptionByText(real, "Static value")) continue;
        // Build first: buildProxy measures the real select's border geometry,
        // which needs it still visible — REAL_ATTR hides it.
        const proxy = buildProxy(real);
        real.setAttribute(REAL_ATTR, "");
        real.after(proxy);
        continue;
      }
      // Keep the proxy mirroring React-driven changes unless mid-flow. The
      // className carries Tulip's valid/invalid styling, which React swaps in
      // place on the (hidden) real select — without mirroring it the proxy
      // keeps whatever state it was born with, e.g. the empty-row red border.
      if (existing.className !== real.className) existing.className = real.className;
      if (!flows.has(real) && existing.value !== real.value) existing.value = real.value;
    }
  }

  function scheduleEnsure() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (active) ensureAll();
    });
  }

  function start() {
    ensureStyles(STYLE_ID, CSS);
    observer = new MutationObserver(scheduleEnsure);
    // attributeFilter: React flips validity styling by rewriting class on the
    // real select in place — a childList-only observer never sees that.
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
    });
    ensureAll();
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    for (const el of document.querySelectorAll(`[${FLOW_ATTR}]`)) el.removeAttribute(FLOW_ATTR);
    for (const el of document.querySelectorAll(`[${PICKER_ATTR}], select[${PROXY_ATTR}]`)) el.remove();
    for (const real of document.querySelectorAll(`[${REAL_ATTR}]`)) real.removeAttribute(REAL_ATTR);
    removeStyles(STYLE_ID);
  }

  registerToggle(FEATURE_ID, {
    onEnable() {
      active = true;
      start();
    },
    onDisable() {
      active = false;
      stop();
    },
  });
})();
