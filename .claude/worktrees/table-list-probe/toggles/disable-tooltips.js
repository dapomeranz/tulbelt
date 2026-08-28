// Suppresses tooltip pop-ups on hover-only action buttons (cut/copy/etc.).
// Tulip has used `data-toggle="tooltip"` and/or a `data-istarget` wrapper with
// `data-placement` on `.hover-button`. We strip those hook-ups while stashing
// originals for restore. Excludes the variables toolbar clone
// (`data-tulbelt-variables-clone`). Persistent toolbar controls that are not
// under `[data-istarget]` / copy-style `data-placement` rows stay untouched.

(() => {
  const { registerToggle, addedNodesObserver } = window.__tulbeltLib;

  const FEATURE_ID = "disable-tooltips";
  const SUPPRESSED_ATTR = "data-tulbelt-tooltip-suppressed";
  const STASH_TOGGLE = "data-tulbelt-stashed-toggle";
  const STASH_PLACEMENT = "data-tulbelt-stashed-placement";
  const STASH_ISTARGET = "data-tulbelt-stashed-istarget";
  /** @deprecated kept for restore only */
  const LEGACY_STASH = "data-tulbelt-tooltip-stash";

  function isVariablesCloneButton(el) {
    return el.closest("[data-tulbelt-variables-clone]");
  }

  function isTooltipTrigger(el) {
    if (!(el instanceof Element) || !el.classList.contains("hover-button")) return false;
    if (isVariablesCloneButton(el)) return false;
    if (el.matches('[data-toggle="tooltip"]')) return true;
    if (el.hasAttribute("data-placement") && el.closest('[data-istarget="true"]')) return true;
    return false;
  }

  function disableTrigger(el) {
    if (!isTooltipTrigger(el) || el.hasAttribute(SUPPRESSED_ATTR)) return;

    const toggle = el.getAttribute("data-toggle");
    if (toggle === "tooltip") {
      el.setAttribute(STASH_TOGGLE, toggle);
      el.removeAttribute("data-toggle");
    }

    const placement = el.getAttribute("data-placement");
    if (placement !== null) {
      el.setAttribute(STASH_PLACEMENT, placement);
      el.removeAttribute("data-placement");
    }

    const istargetWrap = el.closest('[data-istarget="true"]');
    if (istargetWrap && !istargetWrap.hasAttribute(STASH_ISTARGET)) {
      const v = istargetWrap.getAttribute("data-istarget");
      istargetWrap.setAttribute(STASH_ISTARGET, v ?? "true");
      istargetWrap.removeAttribute("data-istarget");
    }

    el.setAttribute(SUPPRESSED_ATTR, "");
  }

  function restoreTrigger(el) {
    if (!el.hasAttribute(SUPPRESSED_ATTR)) return;

    const stashedToggle = el.getAttribute(STASH_TOGGLE);
    if (stashedToggle !== null) {
      el.setAttribute("data-toggle", stashedToggle);
      el.removeAttribute(STASH_TOGGLE);
    }

    const stashedPlacement = el.getAttribute(STASH_PLACEMENT);
    if (stashedPlacement !== null) {
      el.setAttribute("data-placement", stashedPlacement);
      el.removeAttribute(STASH_PLACEMENT);
    }

    const wrap = el.closest(`[${STASH_ISTARGET}]`);
    if (wrap) {
      const v = wrap.getAttribute(STASH_ISTARGET);
      wrap.setAttribute("data-istarget", v);
      wrap.removeAttribute(STASH_ISTARGET);
    }

    el.removeAttribute(SUPPRESSED_ATTR);
  }

  function restoreLegacy() {
    for (const el of document.querySelectorAll(`[${LEGACY_STASH}]`)) {
      const original = el.getAttribute(LEGACY_STASH);
      if (original) el.setAttribute("data-toggle", original);
      el.removeAttribute(LEGACY_STASH);
    }
  }

  function applyToAll() {
    for (const el of document.querySelectorAll(".hover-button")) {
      disableTrigger(el);
    }
  }

  function restoreAll() {
    for (const el of document.querySelectorAll(`[${SUPPRESSED_ATTR}]`)) {
      restoreTrigger(el);
    }
    restoreLegacy();
    for (const el of document.querySelectorAll(`[${STASH_ISTARGET}]`)) {
      const v = el.getAttribute(STASH_ISTARGET);
      el.setAttribute("data-istarget", v);
      el.removeAttribute(STASH_ISTARGET);
    }
  }

  // disableTrigger is idempotent (guarded by SUPPRESSED_ATTR), so re-scanning
  // the whole document on each matching mutation batch is safe.
  const observer = addedNodesObserver(".hover-button", applyToAll);

  registerToggle(FEATURE_ID, {
    onEnable() {
      applyToAll();
      observer.start();
    },
    onDisable() {
      observer.stop();
      restoreAll();
    },
  });
})();
