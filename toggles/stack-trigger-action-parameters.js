// Stacks each argument of a trigger action onto its own line. Tulip lays those
// argument units out inline, so a long action is one crowded row. Making each
// unit a full-width flex row (the Pretty Triggers userscript) puts the next
// argument underneath.
//
// Parameter names are different lengths, so the first field of each parameter
// would start in a different place. Within one action, the name is padded to
// the widest name in that action, which lines the first fields up. Fields
// after the first stay where they are, and each action measures itself, so
// actions do not line up with each other. The action-type dropdown is not a
// name (its first child is the select), so it is left full width.
//
// The rule stops at the unit: value inputs, the pieces inside an argument,
// and the action-type selects belong to the other trigger-editor toggles.
// align-items keeps those selects from stretching once the unit is a flex
// row; min-width: 0 lets a long value stop at the row instead of spilling
// past it. Removing the stylesheet and the name padding restores Tulip's
// inline layout.

(() => {
  const { registerToggle, ensureStyles, removeStyles } = window.__tulbeltLib;

  const FEATURE_ID = "stack-trigger-action-parameters";
  const STYLE_ID = "tulbelt-stack-trigger-action-parameters-styles";
  const MARK = "data-tulbelt-stap-label";

  const ACTION_SEL = ".action-body";
  const UNIT_SEL = ".imports-triggers-editor-client-styles--triggerUnitStyles";
  const FIELD_SEL = "select, input, textarea";

  const CSS = `
    .action-body .imports-triggers-editor-client-styles--triggerUnitStyles {
      display: flex !important;
      width: 100% !important;
      align-items: center;
      min-width: 0;
      box-sizing: border-box;
    }
  `;

  let active = false;
  let observer = null;
  let scheduled = false;

  // The parameter name is the unit's first element, and it holds no field of
  // its own. A unit whose first element is the action-type select (or wraps
  // one) is the action header, not a parameter.
  function parameterLabel(unit) {
    const first = unit.firstElementChild;
    if (!first) return null;
    if (first.matches(FIELD_SEL) || first.querySelector(FIELD_SEL)) return null;
    if (!first.textContent.trim()) return null;
    return first;
  }

  function contentWidth(el) {
    const prevMin = el.style.minWidth;
    const prevShrink = el.style.flexShrink;
    el.style.flexShrink = "0";
    el.style.minWidth = "max-content";
    const width = el.offsetWidth;
    el.style.minWidth = prevMin;
    el.style.flexShrink = prevShrink;
    return width;
  }

  function clearLabel(el) {
    el.style.removeProperty("min-width");
    el.style.removeProperty("flex-shrink");
    el.style.removeProperty("white-space");
    el.removeAttribute(MARK);
  }

  function alignAll() {
    const keep = new Set();
    for (const action of document.querySelectorAll(ACTION_SEL)) {
      const labels = [];
      for (const unit of action.querySelectorAll(UNIT_SEL)) {
        if (unit.closest(ACTION_SEL) !== action) continue;
        const label = parameterLabel(unit);
        if (!label) continue;
        labels.push(label);
      }
      let max = 0;
      for (const label of labels) {
        const width = contentWidth(label);
        if (width > max) max = width;
      }
      if (!max) continue;
      const px = `${max}px`;
      for (const label of labels) {
        label.style.flexShrink = "0";
        label.style.whiteSpace = "nowrap";
        label.style.minWidth = px;
        label.setAttribute(MARK, "");
        keep.add(label);
      }
    }
    for (const el of document.querySelectorAll(`[${MARK}]`)) {
      if (!keep.has(el)) clearLabel(el);
    }
  }

  function restoreLabels() {
    for (const el of document.querySelectorAll(`[${MARK}]`)) clearLabel(el);
  }

  function scheduleAlign() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (active) alignAll();
    });
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(scheduleAlign);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function stopObserver() {
    observer?.disconnect();
    observer = null;
  }

  registerToggle(FEATURE_ID, {
    onEnable() {
      active = true;
      ensureStyles(STYLE_ID, CSS);
      alignAll();
      startObserver();
    },
    onDisable() {
      active = false;
      stopObserver();
      restoreLabels();
      removeStyles(STYLE_ID);
    },
  });
})();
