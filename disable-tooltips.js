// Suppresses tooltip pop-ups on elements that opt in via `data-toggle="tooltip"`.
// Bootstrap-style tooltips read the attribute on hover/focus and inject a
// `[role="tooltip"]` node into the body; stripping the attribute on the trigger
// and hiding any tooltip nodes that slip through covers both pre- and
// post-initialization cases.

(() => {
const TRIGGER_SELECTOR = '[data-toggle="tooltip"]';
const FEATURE_ID = 'disable-tooltips';
const STORAGE_KEY = 'toggles';
const STYLE_ID = 'tulbelt-disable-tooltips-styles';
const STASH_ATTR = 'data-tulbelt-tooltip-stash';

let enabled = false;
let observer = null;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    [role="tooltip"],
    .tooltip,
    .bs-tooltip-top,
    .bs-tooltip-bottom,
    .bs-tooltip-left,
    .bs-tooltip-right { display: none !important; }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function removeStyles() {
  document.getElementById(STYLE_ID)?.remove();
}

function disableTrigger(el) {
  if (el.hasAttribute(STASH_ATTR)) return;
  const original = el.getAttribute('data-toggle');
  if (original !== 'tooltip') return;
  el.setAttribute(STASH_ATTR, original);
  el.removeAttribute('data-toggle');
}

function restoreTrigger(el) {
  const original = el.getAttribute(STASH_ATTR);
  if (original === null) return;
  el.setAttribute('data-toggle', original);
  el.removeAttribute(STASH_ATTR);
}

function applyToAll() {
  for (const el of document.querySelectorAll(TRIGGER_SELECTOR)) {
    disableTrigger(el);
  }
}

function restoreAll() {
  for (const el of document.querySelectorAll(`[${STASH_ATTR}]`)) {
    restoreTrigger(el);
  }
}

function onMutation(mutations) {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (!(node instanceof Element)) continue;
      if (node.matches?.(TRIGGER_SELECTOR)) disableTrigger(node);
      const nested = node.querySelectorAll?.(TRIGGER_SELECTOR);
      if (nested?.length) for (const el of nested) disableTrigger(el);
    }
  }
}

function startObserver() {
  if (observer) return;
  observer = new MutationObserver(onMutation);
  observer.observe(document.body, { childList: true, subtree: true });
}

function stopObserver() {
  observer?.disconnect();
  observer = null;
}

async function syncFromStorage() {
  const { [STORAGE_KEY]: stored = {} } =
    await chrome.storage.local.get(STORAGE_KEY);
  const next = stored[FEATURE_ID] ?? true;
  if (next === enabled) return;
  enabled = next;
  if (enabled) {
    ensureStyles();
    applyToAll();
    startObserver();
  } else {
    stopObserver();
    restoreAll();
    removeStyles();
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) syncFromStorage();
});

syncFromStorage();
})();
