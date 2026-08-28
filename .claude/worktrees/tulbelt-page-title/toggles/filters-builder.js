// Visual builder for the connector-function `filters` query parameter, built
// on Tulip's pill field. The field's value is an ordered token list — one
// <input> per text run, one `.param-pill` div per variable — and pills always
// sit INSIDE JSON string literals: the quotes around a pill live in the
// neighboring text tokens (`…"arg": "` + [pill] + `"},…`). So the canonical
// plain-text form is the in-order concatenation with each pill spliced in as
// `$Label$`, and an arg that reads `$Name$` is a variable reference (rendered
// as a chip in our UI). Pills outside a string literal can't be produced by
// Tulip's own UI, so we don't handle them.
//
// The token list is only how the field RENDERS. Its React state (probed via
// the component fiber) is the single canonical string itself, owned by the
// nearest ancestor with props { value: string, onChange: fn(string) }. So
// writes don't touch the tokens at all: this half dispatches the new string
// to the MAIN-world half (filters-builder-main.js), which calls that onChange
// directly, and Tulip re-renders inputs and pills from the string.

(() => {
  const { registerToggle, ensureStyles, removeStyles } = window.__tulbeltLib;

  const FEATURE_ID = "filters-builder";

  // `<input placeholder="Add key">` is what Tulip renders for each query-param
  // key cell. The placeholder is stable across styled-component rebuilds; the
  // `sc-*` hashed classes around it are not.
  const KEY_INPUT_SELECTOR = 'input[placeholder="Add key"]';

  // CSS-module class name on the value-cell wrapper. CSS-module names are
  // stable; the styled-component hashes around them aren't.
  const VALUE_WRAPPER_SELECTOR = '[class*="TextInputWithPills-styles--styles"]';
  const PILL_SELECTOR = ".param-pill";

  // An arg that is exactly `$Name$` is a variable reference — Tulip renders it
  // as a pill and substitutes the variable's value at submit time.
  const VAR_RE = /^\$([^$]+)\$$/;

  const HIDDEN_ROW_ATTR = "data-tulbelt-filters-hidden-row";
  const BUILDER_CLASS = "tulbelt-filters";
  const BUILDER_BLOCK_CLASS = "tulbelt-filters-block";
  const STYLE_ID = "tulbelt-filters-builder-styles";

  const FUNCTION_TYPES = [
    { value: "equal", label: "equal", arg: "single" },
    { value: "notEqual", label: "notEqual", arg: "single" },
    { value: "blank", label: "blank", arg: "none" },
    { value: "notBlank", label: "notBlank", arg: "none" },
    { value: "greaterThan", label: "greaterThan (>)", arg: "single" },
    { value: "greaterThanOrEqual", label: "greaterThanOrEqual (≥)", arg: "single" },
    { value: "lessThan", label: "lessThan (<)", arg: "single" },
    { value: "lessThanOrEqual", label: "lessThanOrEqual (≤)", arg: "single" },
    { value: "isIn", label: "isIn", arg: "array" },
    { value: "notIsIn", label: "notIsIn", arg: "array" },
    { value: "contains", label: "contains", arg: "single" },
    { value: "notContains", label: "notContains", arg: "single" },
    { value: "startsWith", label: "startsWith", arg: "single" },
    { value: "notStartsWith", label: "notStartsWith", arg: "single" },
    { value: "endsWith", label: "endsWith", arg: "single" },
    { value: "notEndsWith", label: "notEndsWith", arg: "single" },
  ];
  const FT_BY_VALUE = new Map(FUNCTION_TYPES.map((ft) => [ft.value, ft]));
  const FT_VALUES = new Set(FUNCTION_TYPES.map((ft) => ft.value));

  let observer = null;
  // Row element -> builder controller. WeakMap so React-replaced rows are
  // auto-collected without leaking.
  const trackedRows = new WeakMap();

  const CSS = `
    [${HIDDEN_ROW_ATTR}="true"] {
      display: none !important;
    }

    .${BUILDER_BLOCK_CLASS} {
      display: flex;
      flex-direction: column;
      gap: 6px;
      width: max-content;
      max-width: 100%;
      align-self: flex-start;
      box-sizing: border-box;
      margin: 8px 0;
      font-family: "Noto Sans", sans-serif;
      font-size: 13px;
      color: inherit;
    }

    /* min-height mimics a native param row height so the header delete lands
       at roughly the same y as the deletes on the rows above and below. */
    .${BUILDER_CLASS}__header {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 36px;
    }
    .${BUILDER_CLASS}__key {
      font-weight: 500;
      color: inherit;
    }
    .${BUILDER_CLASS}__eq {
      color: rgba(0, 0, 0, 0.5);
      font-weight: 500;
    }
    .${BUILDER_CLASS}__count {
      color: rgba(0, 0, 0, 0.55);
      font-size: 12px;
    }
    .${BUILDER_CLASS}__header-spacer { flex: 1 1 auto; }

    .${BUILDER_CLASS}__warning {
      background: rgba(255, 224, 130, 0.35);
      color: #8a6d3b;
      border: 1px solid rgba(255, 193, 7, 0.5);
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      line-height: 1.4;
    }

    .${BUILDER_CLASS}__list {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .${BUILDER_CLASS}__row {
      display: grid;
      grid-template-columns:
        minmax(120px, 240px) minmax(100px, 180px) minmax(140px, 320px) auto;
      gap: 6px;
      align-items: center;
      min-width: 0;
    }
    .${BUILDER_CLASS}__row input,
    .${BUILDER_CLASS}__row select {
      box-sizing: border-box;
      width: 100%;
      padding: 5px 8px;
      border: 1px solid rgba(0, 0, 0, 0.2);
      border-radius: 4px;
      font-family: inherit;
      font-size: 13px;
      background: rgba(255, 255, 255, 0.85);
      color: inherit;
      min-width: 0;
    }
    .${BUILDER_CLASS}__row input:focus,
    .${BUILDER_CLASS}__row select:focus {
      outline: 0;
      border-color: #3a82f7;
      box-shadow: 0 0 0 2px rgba(58, 130, 247, 0.25);
    }
    .${BUILDER_CLASS}__row--no-arg .${BUILDER_CLASS}__arg-cell {
      visibility: hidden;
    }
    .${BUILDER_CLASS}__arg-cell {
      display: flex;
      align-items: center;
      min-width: 0;
    }
    .${BUILDER_CLASS}__pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      max-width: 100%;
      padding: 2px 8px;
      border-radius: 12px;
      background: #e7f0fe;
      border: 1px solid #b3d1fb;
      color: #1d4f9c;
      font-size: 12px;
      line-height: 1.6;
      white-space: nowrap;
    }
    .${BUILDER_CLASS}__pill-label {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .${BUILDER_CLASS}__pill-x {
      border: 0;
      background: transparent;
      cursor: pointer;
      color: inherit;
      padding: 0 2px;
      font-size: 13px;
      line-height: 1;
    }
    .${BUILDER_CLASS}__pill-x:hover {
      color: #c0392b;
    }
    .${BUILDER_CLASS}__btn {
      background: transparent;
      border: 0;
      cursor: pointer;
      color: rgba(0, 0, 0, 0.45);
      padding: 2px 4px;
      border-radius: 4px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .${BUILDER_CLASS}__btn:hover {
      background: rgba(0, 0, 0, 0.06);
      color: rgba(0, 0, 0, 0.8);
    }
    .${BUILDER_CLASS}__add {
      align-self: flex-start;
      background: transparent;
      border: 1px dashed rgba(0, 0, 0, 0.25);
      border-radius: 4px;
      color: rgba(0, 0, 0, 0.55);
      cursor: pointer;
      padding: 4px 10px;
      font-family: inherit;
      font-size: 12px;
    }
    .${BUILDER_CLASS}__add:hover {
      border-color: #3a82f7;
      color: #3a82f7;
    }
    .${BUILDER_CLASS}__empty {
      color: rgba(0, 0, 0, 0.45);
      font-size: 12px;
      font-style: italic;
    }
  `;

  // Walk up from a key input to the row container holding the key cell, the
  // literal "=" separator, and the value cell.
  function findRow(keyInput) {
    let node = keyInput.parentElement;
    while (node && node !== document.body) {
      const wrappers = node.querySelectorAll(VALUE_WRAPPER_SELECTOR);
      if (wrappers.length >= 2) {
        const hasEquals = Array.from(node.children).some((c) => c.textContent?.trim() === "=");
        if (hasEquals) return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  function getValueWrapper(row, keyInput) {
    for (const w of row.querySelectorAll(VALUE_WRAPPER_SELECTOR)) {
      if (!w.contains(keyInput)) return w;
    }
    return null;
  }

  // Canonical-text read: walk the token list in order, concatenating text-run
  // input values and splicing each pill in as raw `$Label$`. Because the
  // enclosing quotes live in the adjacent text tokens, the result is valid
  // JSON with `"$Label$"` strings where the pills were.
  function getValueText(wrapper) {
    let out = "";
    for (const child of wrapper.children) {
      if (child.matches?.(PILL_SELECTOR)) {
        out += `$${child.textContent?.trim() ?? ""}$`;
        continue;
      }
      const input = child.matches?.("input") ? child : child.querySelector?.("input");
      if (input) out += input.value;
    }
    return out;
  }

  function stringifyArg(arg) {
    if (arg === undefined || arg === null) return "";
    if (typeof arg === "string") return arg;
    try {
      return JSON.stringify(arg);
    } catch {
      return "";
    }
  }

  function parseFiltersValue(wrapper) {
    const text = getValueText(wrapper);
    if (text.trim() === "") {
      return { filters: [], parseError: false };
    }
    try {
      const data = JSON.parse(text);
      if (!Array.isArray(data)) {
        return { filters: [], parseError: true };
      }
      const filters = [];
      for (const f of data) {
        if (!f || typeof f !== "object") continue;
        const field = typeof f.field === "string" ? f.field : "";
        const functionType = FT_VALUES.has(f.functionType) ? f.functionType : "equal";
        const arg = stringifyArg(f.arg);
        filters.push({ field, functionType, arg });
      }
      return { filters, parseError: false };
    } catch {
      return { filters: [], parseError: true };
    }
  }

  // Best-effort coercion of free-text arg into the JSON value to emit. JSON.parse
  // first (so `123`, `true`, `"x"` round-trip) with fall-back to the raw string
  // for things like ISO timestamps or bare text.
  function coerceSingleArg(raw) {
    const trimmed = raw.trim();
    if (trimmed === "") return "";
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw;
    }
  }

  function coerceArrayArg(raw) {
    const trimmed = raw.trim();
    if (trimmed === "") return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fall through to comma-split
    }
    return trimmed
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  function serializeFilters(filters) {
    const out = [];
    for (const f of filters) {
      const ft = FT_BY_VALUE.get(f.functionType);
      const obj = { field: f.field, functionType: f.functionType };
      if (!ft || ft.arg === "none") {
        out.push(obj);
        continue;
      }
      if (ft.arg === "array") {
        obj.arg = coerceArrayArg(f.arg ?? "");
      } else {
        obj.arg = coerceSingleArg(f.arg ?? "");
      }
      out.push(obj);
    }
    return JSON.stringify(out);
  }

  // Write path: hand the canonical string to the MAIN-world half
  // (filters-builder-main.js), which calls the React onChange that owns the
  // field's state. One synchronous state write — no token surgery, nothing to
  // coalesce; Tulip re-renders the pills from the new string itself.
  const WRITE_EVENT = "tulbelt:filters-write";
  const WRITE_RESULT_EVENT = "tulbelt:filters-write-result";

  // valueWrapper -> the builder's setWarning, so write failures reported by
  // the MAIN half can surface in the right builder.
  const wrapperWarn = new WeakMap();

  function pushJson(wrapper, json) {
    wrapper.dispatchEvent(new CustomEvent(WRITE_EVENT, { bubbles: true, detail: json }));
  }

  function onWriteResult(e) {
    let result;
    try {
      result = JSON.parse(e.detail);
    } catch {
      return;
    }
    const warn = e.target instanceof Element ? wrapperWarn.get(e.target) : null;
    if (result.ok) {
      warn?.(null);
      return;
    }
    warn?.(
      `Couldn't update the value through Tulip's editor (${result.error || "unknown error"}); the field was left untouched.`,
    );
  }

  const TRASH_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"></path></svg>`;

  function makeTrashButton(label, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `${BUILDER_CLASS}__btn`;
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.innerHTML = TRASH_ICON;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  function buildBuilder({ initialFilters, keyLabel, onChange, sourceRow }) {
    const filters = initialFilters.map((f) => ({ ...f }));
    // Never write into Tulip's field until the user actually edits something —
    // the initial render must not "normalize" (or, after a bad parse, wipe)
    // the existing value.
    let dirty = false;

    const root = document.createElement("div");
    root.className = BUILDER_BLOCK_CLASS;

    const header = document.createElement("div");
    header.className = `${BUILDER_CLASS}__header`;
    root.appendChild(header);

    const keyEl = document.createElement("span");
    keyEl.className = `${BUILDER_CLASS}__key`;
    keyEl.textContent = keyLabel;
    header.appendChild(keyEl);

    const eqEl = document.createElement("span");
    eqEl.className = `${BUILDER_CLASS}__eq`;
    eqEl.textContent = "=";
    header.appendChild(eqEl);

    const countEl = document.createElement("span");
    countEl.className = `${BUILDER_CLASS}__count`;
    header.appendChild(countEl);

    const spacer = document.createElement("span");
    spacer.className = `${BUILDER_CLASS}__header-spacer`;
    header.appendChild(spacer);

    // Proxy to whatever delete button is live on the hidden row at click time,
    // so React re-renders don't break us.
    header.appendChild(
      makeTrashButton("Delete parameter", () => {
        sourceRow.querySelector('button[aria-label="Delete"]')?.click();
      }),
    );

    let warningEl = null;
    function setWarning(text) {
      if (!text) {
        warningEl?.remove();
        warningEl = null;
        return;
      }
      if (!warningEl) {
        warningEl = document.createElement("div");
        warningEl.className = `${BUILDER_CLASS}__warning`;
        root.insertBefore(warningEl, header.nextSibling);
      }
      warningEl.textContent = text;
    }

    const list = document.createElement("div");
    list.className = `${BUILDER_CLASS}__list`;
    root.appendChild(list);

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = `${BUILDER_CLASS}__add`;
    addBtn.textContent = "+ Add filter";
    addBtn.addEventListener("click", () => {
      dirty = true;
      filters.push({ field: "", functionType: "equal", arg: "" });
      rerender({ focusLast: true });
    });
    root.appendChild(addBtn);

    function updateCount() {
      countEl.textContent = filters.length
        ? `(${filters.length} filter${filters.length === 1 ? "" : "s"})`
        : "";
    }

    function emit() {
      updateCount();
      if (!dirty) return;
      onChange(serializeFilters(filters));
    }

    function buildRow(filter, index) {
      const row = document.createElement("div");
      row.className = `${BUILDER_CLASS}__row`;
      const ft = FT_BY_VALUE.get(filter.functionType);
      if (ft?.arg === "none") row.classList.add(`${BUILDER_CLASS}__row--no-arg`);

      const fieldInput = document.createElement("input");
      fieldInput.type = "text";
      fieldInput.placeholder = "field";
      fieldInput.spellcheck = false;
      fieldInput.value = filter.field;
      fieldInput.className = `${BUILDER_CLASS}__field`;
      fieldInput.addEventListener("input", () => {
        dirty = true;
        filter.field = fieldInput.value;
        emit();
      });
      row.appendChild(fieldInput);

      const select = document.createElement("select");
      select.className = `${BUILDER_CLASS}__op`;
      for (const def of FUNCTION_TYPES) {
        const opt = document.createElement("option");
        opt.value = def.value;
        opt.textContent = def.label;
        select.appendChild(opt);
      }
      select.value = filter.functionType;
      select.addEventListener("change", () => {
        dirty = true;
        filter.functionType = select.value;
        rerender();
      });
      row.appendChild(select);

      const argCell = document.createElement("div");
      argCell.className = `${BUILDER_CLASS}__arg-cell`;
      const varMatch = ft?.arg === "single" ? VAR_RE.exec((filter.arg ?? "").trim()) : null;
      if (varMatch) {
        // Variable reference: show a chip instead of the `$Name$` text. The
        // stored arg stays the `$Name$` string; the chip is purely cosmetic.
        const chip = document.createElement("span");
        chip.className = `${BUILDER_CLASS}__pill`;
        chip.title = `Variable: ${varMatch[1]}`;
        const label = document.createElement("span");
        label.className = `${BUILDER_CLASS}__pill-label`;
        label.textContent = varMatch[1];
        chip.appendChild(label);
        const clear = document.createElement("button");
        clear.type = "button";
        clear.className = `${BUILDER_CLASS}__pill-x`;
        clear.title = "Remove variable";
        clear.setAttribute("aria-label", "Remove variable");
        clear.textContent = "×";
        clear.addEventListener("click", () => {
          dirty = true;
          filter.arg = "";
          rerender();
        });
        chip.appendChild(clear);
        argCell.appendChild(chip);
      } else {
        const argInput = document.createElement("input");
        argInput.type = "text";
        argInput.spellcheck = false;
        argInput.className = `${BUILDER_CLASS}__arg`;
        if (ft?.arg === "array") {
          argInput.placeholder = '["a", "b"] or a, b, c';
        } else if (ft?.arg === "none") {
          argInput.placeholder = "";
          argInput.disabled = true;
        } else {
          argInput.placeholder = "value or $Variable$";
        }
        argInput.value = filter.arg ?? "";
        argInput.addEventListener("input", () => {
          dirty = true;
          filter.arg = argInput.value;
          // Typing a complete `$Name$` converts to a chip (rerender emits).
          if (ft?.arg === "single" && VAR_RE.test(argInput.value.trim())) {
            filter.arg = argInput.value.trim();
            rerender();
            return;
          }
          emit();
        });
        argCell.appendChild(argInput);
      }
      row.appendChild(argCell);

      row.appendChild(
        makeTrashButton("Remove filter", () => {
          dirty = true;
          filters.splice(index, 1);
          rerender();
        }),
      );

      return { row, fieldInput };
    }

    function rerender(opts = {}) {
      list.replaceChildren();
      let lastBuilt = null;
      filters.forEach((f, i) => {
        const built = buildRow(f, i);
        list.appendChild(built.row);
        lastBuilt = built;
      });
      if (filters.length === 0) {
        const empty = document.createElement("div");
        empty.className = `${BUILDER_CLASS}__empty`;
        empty.textContent = 'No filters. Click "+ Add filter" to start.';
        list.appendChild(empty);
      }
      if (opts.focusLast && lastBuilt) lastBuilt.fieldInput.focus();
      emit();
    }

    rerender();

    return { root, setWarning };
  }

  function attachBuilder(row, keyInput) {
    const valueWrapper = getValueWrapper(row, keyInput);
    if (!valueWrapper) return;

    const existing = trackedRows.get(row);
    if (existing) {
      if (row.getAttribute(HIDDEN_ROW_ATTR) !== "true") {
        row.setAttribute(HIDDEN_ROW_ATTR, "true");
      }
      if (!existing.host.isConnected || existing.host.previousElementSibling !== row) {
        row.parentElement?.insertBefore(existing.host, row.nextSibling);
      }
      return;
    }

    const { filters, parseError } = parseFiltersValue(valueWrapper);

    const builder = buildBuilder({
      initialFilters: filters,
      keyLabel: keyInput.value,
      onChange: (json) => pushJson(valueWrapper, json),
      sourceRow: row,
    });

    if (parseError) {
      builder.setWarning(
        "Existing value could not be parsed as JSON; starting with an empty filter list. Saving will overwrite the existing value.",
      );
    }

    row.parentElement.insertBefore(builder.root, row.nextSibling);
    row.setAttribute(HIDDEN_ROW_ATTR, "true");

    trackedRows.set(row, { host: builder.root, valueWrapper });
    wrapperWarn.set(valueWrapper, builder.setWarning);
  }

  function detachBuilder(row) {
    const data = trackedRows.get(row);
    if (!data) return;
    data.host.remove();
    row.removeAttribute(HIDDEN_ROW_ATTR);
    trackedRows.delete(row);
    wrapperWarn.delete(data.valueWrapper);
  }

  function reconcile() {
    for (const keyInput of document.querySelectorAll(KEY_INPUT_SELECTOR)) {
      const row = findRow(keyInput);
      if (!row) continue;
      if (keyInput.value === "filters") {
        attachBuilder(row, keyInput);
      } else {
        detachBuilder(row);
      }
    }
  }

  function restoreAll() {
    for (const row of document.querySelectorAll(`[${HIDDEN_ROW_ATTR}="true"]`)) {
      detachBuilder(row);
    }
    // Sweep hosts whose rows React already removed.
    for (const host of document.querySelectorAll(`.${BUILDER_BLOCK_CLASS}`)) {
      host.remove();
    }
  }

  function mutationTouchesTarget(node) {
    if (!(node instanceof Element)) return false;
    return (
      node.matches?.(KEY_INPUT_SELECTOR) ||
      node.querySelector?.(KEY_INPUT_SELECTOR) ||
      node.matches?.(VALUE_WRAPPER_SELECTOR) ||
      node.querySelector?.(VALUE_WRAPPER_SELECTOR)
    );
  }

  function onMutation(mutations) {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (mutationTouchesTarget(node)) {
          reconcile();
          return;
        }
      }
      for (const node of m.removedNodes) {
        if (node instanceof Element && trackedRows.has(node)) {
          const data = trackedRows.get(node);
          data?.host.remove();
          trackedRows.delete(node);
        }
      }
    }
  }

  function onInputCapture(e) {
    if (!(e.target instanceof HTMLInputElement)) return;
    // Builder-owned inputs handle their own state.
    if (e.target.closest(`.${BUILDER_BLOCK_CLASS}`)) return;
    if (e.target.matches(KEY_INPUT_SELECTOR)) reconcile();
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(onMutation);
    observer.observe(document.body, { childList: true, subtree: true });
    document.body.addEventListener("input", onInputCapture, true);
    document.addEventListener(WRITE_RESULT_EVENT, onWriteResult, true);
  }

  function stopObserver() {
    observer?.disconnect();
    observer = null;
    document.body.removeEventListener("input", onInputCapture, true);
    document.removeEventListener(WRITE_RESULT_EVENT, onWriteResult, true);
  }

  registerToggle(FEATURE_ID, {
    onEnable() {
      ensureStyles(STYLE_ID, CSS);
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
