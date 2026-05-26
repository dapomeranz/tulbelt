// Adds a "Expand variable paths" button to the app editor toolbar (next to
// the snapshot/translation controls). When clicked, finds every variable
// trigger button on the page that currently shows just a leaf name, opens
// each dropdown briefly to learn the selected item's full hierarchy path,
// closes the dropdown, and rewrites the button label.
//
// A small status pill ("3 / 12") is shown next to the button during the run.
// Skips buttons that have no nested selection (top-level variables) and
// buttons already patched by the variable-full-path toggle.

(() => {
const FEATURE_ID = 'expand-all-variable-paths';
const STORAGE_KEY = 'toggles';
const BTN_ID = 'tulbelt-expand-paths-btn';
const STATUS_ID = 'tulbelt-expand-paths-status';
const STYLE_ID = 'tulbelt-expand-paths-styles';

// Selectors duplicated from variable-full-path.js — these toggles are
// intentionally self-contained, matching the project's per-toggle style.
const TRIGGER_BTN_SELECTOR = 'button[aria-label="Select new variable or array"]';
const SCROLL_CONTAINER_SELECTOR = '[style*="overflow: auto"][style*="will-change: transform"]';
const STASH_ATTR = 'data-tulbelt-vfp-original';
const PATCHED_ATTR = 'data-tulbelt-vfp-patched';

// Anchor selectors for the trigger editor modal. We insert next to the X
// close button (top-right of the modal) since the copy-link icon is in the
// middle of the title row, not at the right edge.
const TRIGGER_EDITOR_SELECTOR = '[data-testid="trigger-editor"]';
const TRIGGER_EDITOR_CLOSE_WRAPPER = '.bootbox-close-button-wrapper';
const APP_EDITOR_ANCHOR_SELECTORS = [
  '#app-editor-translation',
  '#app-editor-snapshot',
];

let enabled = false;
let observer = null;
let running = false;

// ---------------------------------------------------------------------------
// Styles for the toolbar button and status pill
// ---------------------------------------------------------------------------
function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${BTN_ID} {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      margin: 0 8px;
      border: 1px solid #1c69e1;
      border-radius: 4px;
      background: #1c69e1;
      color: #fff;
      font-size: 12px;
      font-weight: 500;
      font-family: inherit;
      cursor: pointer;
      line-height: 1.4;
      white-space: nowrap;
    }
    #${BTN_ID}:hover { background: #1556b8; border-color: #1556b8; }
    #${BTN_ID}:disabled { opacity: 0.6; cursor: progress; }
    #${STATUS_ID} {
      display: inline-block;
      margin-left: 4px;
      padding: 2px 6px;
      border-radius: 10px;
      background: rgba(255,255,255,0.25);
      color: #fff;
      font-size: 11px;
      font-weight: 600;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function removeStyles() {
  document.getElementById(STYLE_ID)?.remove();
}

// ---------------------------------------------------------------------------
// Helpers (mirror of variable-full-path.js)
// ---------------------------------------------------------------------------
function findVariableContainer() {
  for (const sc of document.querySelectorAll(SCROLL_CONTAINER_SELECTOR)) {
    if (sc.querySelector('li')) return sc;
  }
  return null;
}

function indentLevel(li) {
  const firstSpan = li.querySelector('button > span:first-child');
  if (!firstSpan) return 0;
  const t = firstSpan.textContent;
  if (!/^[\s\u00a0]+$/.test(t)) return 0;
  return t.length;
}

function itemLabel(li) {
  const btn = li.querySelector('button');
  return btn?.getAttribute('aria-label') || btn?.getAttribute('data-testid') || btn?.textContent?.trim() || null;
}

// Build full path for the currently-selected item in the open dropdown.
// The selected row has aria-selected="true" on its button, OR is uniquely
// styled. Fallback: match the visible leaf name on the trigger button.
function buildPathForSelected(scrollContainer, expectedLeafName) {
  const rows = [...(scrollContainer.firstElementChild
    ?.querySelectorAll(':scope > div[style*="position: absolute"]') || [])]
    .sort((a, b) => parseInt(a.style.top) - parseInt(b.style.top));

  // Find the row whose button matches the expected leaf and has aria-selected
  let selectedIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const li = rows[i].querySelector('li');
    const btn = li?.querySelector('button');
    if (!btn) continue;
    const ariaSel = btn.getAttribute('aria-selected');
    const label = itemLabel(li);
    if (ariaSel === 'true' && label === expectedLeafName) { selectedIdx = i; break; }
  }
  // Fallback: any row with matching label
  if (selectedIdx < 0) {
    for (let i = 0; i < rows.length; i++) {
      const li = rows[i].querySelector('li');
      if (li?.hasAttribute('disabled')) continue;
      if (itemLabel(li) === expectedLeafName) { selectedIdx = i; break; }
    }
  }
  if (selectedIdx < 0) return null;

  const clickedLi = rows[selectedIdx].querySelector('li');
  const clickedIndent = indentLevel(clickedLi);
  if (clickedIndent === 0) return null; // top-level, no path

  const path = [itemLabel(clickedLi)];
  let currentIndent = clickedIndent;

  for (let i = selectedIdx - 1; i >= 0 && currentIndent > 0; i--) {
    const li = rows[i].querySelector('li');
    if (!li) continue;
    const indent = indentLevel(li);
    const isHeader = li.hasAttribute('disabled') && indent === 0;
    if (indent < currentIndent || isHeader) {
      const label = itemLabel(li);
      if (label) path.unshift(label);
      currentIndent = isHeader ? 0 : indent;
    }
  }

  return path.length > 1 ? path.join(' → ') : null;
}

function patchButton(btn, path) {
  const labelEl = btn.querySelector('div > div > div > div') || btn.querySelector('div');
  const target = labelEl || btn;
  if (target.getAttribute(PATCHED_ATTR) === path) return;
  if (!target.hasAttribute(STASH_ATTR)) {
    target.setAttribute(STASH_ATTR, target.textContent);
  }
  target.setAttribute(PATCHED_ATTR, path);
  target.textContent = path;
}

// Get the currently-visible leaf text of a variable trigger button.
function getButtonLeafText(btn) {
  const labelEl = btn.querySelector('div > div > div > div') || btn.querySelector('div');
  return labelEl?.textContent?.trim() || null;
}

// Has this button already been patched (by this script or the live toggle)?
function isPatched(btn) {
  const labelEl = btn.querySelector('div > div > div > div') || btn.querySelector('div');
  return labelEl?.hasAttribute(PATCHED_ATTR);
}

// ---------------------------------------------------------------------------
// Wait helpers
// ---------------------------------------------------------------------------
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function waitForContainer(timeoutMs = 800) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const sc = findVariableContainer();
      if (sc) return resolve(sc);
      if (Date.now() - start > timeoutMs) return resolve(null);
      requestAnimationFrame(tick);
    };
    tick();
  });
}

function waitForContainerGone(timeoutMs = 500) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (!findVariableContainer()) return resolve();
      if (Date.now() - start > timeoutMs) return resolve();
      requestAnimationFrame(tick);
    };
    tick();
  });
}

// ---------------------------------------------------------------------------
// Process one button: open dropdown, read selected path, close, patch.
// ---------------------------------------------------------------------------
async function processButton(btn) {
  const leafName = getButtonLeafText(btn);
  if (!leafName || leafName === '' || leafName === 'Select new variable or array') return false;

  // Open dropdown
  btn.click();
  const sc = await waitForContainer(800);
  if (!sc) return false;

  // Build path for the selected item
  const path = buildPathForSelected(sc, leafName);

  // Close dropdown (click button again, or press Escape)
  btn.click();
  await waitForContainerGone(500);

  if (path) {
    patchButton(btn, path);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main run loop
// ---------------------------------------------------------------------------
async function runExpand() {
  if (running) return;
  running = true;

  const btn = document.getElementById(BTN_ID);
  const status = document.getElementById(STATUS_ID);
  if (btn) btn.disabled = true;

  const candidates = [...document.querySelectorAll(TRIGGER_BTN_SELECTOR)]
    .filter((b) => !isPatched(b));

  const total = candidates.length;
  let done = 0;

  if (status) status.textContent = `0 / ${total}`;

  for (const candidate of candidates) {
    try {
      await processButton(candidate);
    } catch (e) {
      // Don't let one bad button stop the run
      console.warn('[tulbelt expand-paths] failed for button', e);
    }
    done++;
    if (status) status.textContent = `${done} / ${total}`;
    // Small breather so React can settle and the user can see progress
    await sleep(60);
  }

  if (status) {
    status.textContent = `Done (${done})`;
    setTimeout(() => { if (status) status.textContent = ''; }, 2000);
  }
  if (btn) btn.disabled = false;
  running = false;
}

// ---------------------------------------------------------------------------
// Insert / remove toolbar button
// ---------------------------------------------------------------------------
function findToolbarAnchor() {
  // Prefer next to the X close button at the modal top-right
  const editor = document.querySelector(TRIGGER_EDITOR_SELECTOR);
  if (editor) {
    // The close button wrapper is a sibling of bootbox-body, not inside the
    // trigger editor itself — search up to modal-body level.
    const modalBody = editor.closest('.modal-body') || editor.closest('.modal-content') || document;
    const closeWrapper = modalBody.querySelector(TRIGGER_EDITOR_CLOSE_WRAPPER);
    if (closeWrapper) return closeWrapper;
  }
  // Fallback to the main app editor toolbar
  for (const sel of APP_EDITOR_ANCHOR_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function insertButton() {
  if (document.getElementById(BTN_ID)) return;
  const anchor = findToolbarAnchor();
  if (!anchor) return;

  const btn = document.createElement('button');
  btn.id = BTN_ID;
  btn.type = 'button';
  btn.title = 'Expand all variable trigger buttons to show full path (Object → Field)';
  btn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M3 6h18v2H3V6zm0 5h12v2H3v-2zm0 5h18v2H3v-2zm15-3v-2l4 3-4 3v-2h-2v-2h2z"/>
    </svg>
    <span>Expand paths</span>
    <span id="${STATUS_ID}"></span>
  `;
  btn.querySelector(`#${STATUS_ID}`).textContent = '';
  // Hide the status pill when empty
  const status = btn.querySelector(`#${STATUS_ID}`);
  const updateStatusVisibility = () => {
    status.style.display = status.textContent ? 'inline-block' : 'none';
  };
  new MutationObserver(updateStatusVisibility).observe(status, { childList: true, characterData: true, subtree: true });
  updateStatusVisibility();

  btn.addEventListener('click', runExpand);
  // If the anchor is the close-button wrapper, insert our button INSIDE it
  // (before the X) so it shares the float-right positioning. Otherwise, insert
  // as a sibling.
  if (anchor.classList.contains('bootbox-close-button-wrapper')) {
    anchor.insertBefore(btn, anchor.firstChild);
  } else {
    anchor.parentElement?.insertBefore(btn, anchor.nextSibling);
  }
}

function removeButton() {
  document.getElementById(BTN_ID)?.remove();
}

// ---------------------------------------------------------------------------
// Observer: keep the button present as Tulip navigates between editor views
// ---------------------------------------------------------------------------
function onMutation() {
  if (!enabled) return;
  const existing = document.getElementById(BTN_ID);
  const anchor = findToolbarAnchor();
  if (!existing && anchor) {
    insertButton();
  } else if (existing && !document.body.contains(existing)) {
    // Already gone; observer will pick it up next mutation
  } else if (existing && anchor && !existing.parentElement) {
    insertButton();
  }
}

function startObserver() {
  if (observer) return;
  observer = new MutationObserver(onMutation);
  observer.observe(document.body, { childList: true, subtree: true });
  insertButton();
}

function stopObserver() {
  observer?.disconnect();
  observer = null;
  removeButton();
}

// ---------------------------------------------------------------------------
// Storage sync
// ---------------------------------------------------------------------------
async function syncFromStorage() {
  const { [STORAGE_KEY]: stored = {} } =
    await chrome.storage.local.get(STORAGE_KEY);
  const next = stored[FEATURE_ID] ?? true;
  if (next === enabled) return;
  enabled = next;
  if (enabled) {
    ensureStyles();
    startObserver();
  } else {
    stopObserver();
    removeStyles();
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) syncFromStorage();
});

syncFromStorage();
})();
