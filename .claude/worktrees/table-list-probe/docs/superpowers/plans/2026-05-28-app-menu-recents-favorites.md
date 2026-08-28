# App Menu Recents & Favorites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "Recents" and "Favorites" links to the top-nav app menu dropdown, appearing after the existing Functions entry.

**Architecture:** A single content script watches `document.body` for the nav popper (`[data-testid="popper"]` containing an `/apps/folders` link), injects two `<li>` elements cloned from the last existing item, and removes them cleanly on disable. Registered in the default content_scripts block and in the FEATURES registry.

**Tech Stack:** Vanilla JS (IIFE, no modules), MV3 content script, chrome.storage.local

---

### Task 1: Add feature registry entry

**Files:**

- Modify: `features.js`

- [ ] **Step 1: Add FEATURES entry**

In `features.js`, append to the `FEATURES` array (after the `collapse-tables-tile` entry):

```js
  {
    id: 'app-menu-recents-favorites',
    name: 'App Menu: Recents & Favorites',
    description:
      'In the top-nav app menu dropdown, add Recents and Favorites links below the existing entries.',
    defaultEnabled: true,
    major: false,
  },
```

- [ ] **Step 2: Syntax check**

```bash
node --check features.js
```

Expected: no output (clean exit).

- [ ] **Step 3: Commit**

```bash
git add features.js
git commit -m "feat: register app-menu-recents-favorites toggle"
```

---

### Task 2: Create the content script

**Files:**

- Create: `toggles/app-menu-recents-favorites.js`

- [ ] **Step 1: Write the file**

```js
(() => {
  const FEATURE_ID = "app-menu-recents-favorites";
  const STORAGE_KEY = "toggles";
  const MARK = "data-tulbelt-amrf";

  let enabled = false;
  let observer = null;

  const ITEMS = [
    { label: "Recents", href: "/apps/folders?view=recents" },
    { label: "Favorites", href: "/apps/folders?view=favorites" },
  ];

  function findTargetUl() {
    for (const popper of document.querySelectorAll('[data-testid="popper"] ul')) {
      if (popper.querySelector('a[href*="/apps/folders"]')) return popper;
    }
    return null;
  }

  function isAlreadyInjected(ul) {
    return !!ul.querySelector("[" + MARK + "]");
  }

  function injectItems(ul) {
    const template = ul.lastElementChild;
    if (!template) return;
    for (const { label, href } of ITEMS) {
      const li = template.cloneNode(true);
      li.setAttribute(MARK, "1");
      li.setAttribute("href", href);
      const a = li.querySelector("a") || li;
      a.setAttribute("href", href);
      a.textContent = label;
      ul.appendChild(li);
    }
  }

  function removeInjections() {
    document.querySelectorAll("[" + MARK + "]").forEach((el) => el.remove());
  }

  function applyToPresent() {
    const ul = findTargetUl();
    if (!ul || isAlreadyInjected(ul)) return;
    injectItems(ul);
  }

  function onMutation(mutations) {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (
          node.matches('[data-testid="popper"]') ||
          node.querySelector('[data-testid="popper"]')
        ) {
          applyToPresent();
          return;
        }
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
    const { [STORAGE_KEY]: stored = {} } = await chrome.storage.local.get(STORAGE_KEY);
    const next = stored[FEATURE_ID] ?? true;
    if (next === enabled) return;
    enabled = next;
    if (enabled) {
      applyToPresent();
      startObserver();
    } else {
      stopObserver();
      removeInjections();
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEY]) syncFromStorage();
  });

  syncFromStorage();
})();
```

- [ ] **Step 2: Syntax check**

```bash
node --check toggles/app-menu-recents-favorites.js
```

Expected: no output (clean exit).

- [ ] **Step 3: Commit**

```bash
git add toggles/app-menu-recents-favorites.js
git commit -m "feat: add app-menu-recents-favorites content script"
```

---

### Task 3: Register in manifest.json

**Files:**

- Modify: `manifest.json`

- [ ] **Step 1: Add script to default content_scripts block**

In `manifest.json`, in the first `content_scripts` entry (the one with `"run_at": "document_idle"` and no `all_frames` or `world` key), add `"toggles/app-menu-recents-favorites.js"` to the `js` array. Append it at the end of the list, after `"toggles/collapse-tables-tile.js"`.

The `js` array should become:

```json
[
  "toggles/reorder-row-buttons.js",
  "toggles/auto-snapshot.js",
  "toggles/hide-legacy.js",
  "toggles/disable-tooltips.js",
  "toggles/hide-view-only-triggers.js",
  "toggles/move-variables-to-toolbar.js",
  "toggles/hide-app-editor-chrome.js",
  "toggles/compact-app-editor-header.js",
  "toggles/dark-mode.js",
  "toggles/strip-tab-title-prefix.js",
  "toggles/filters-builder.js",
  "toggles/expression-editor-fuzzy.js",
  "toggles/collapse-tables-tile.js",
  "toggles/app-menu-recents-favorites.js"
]
```

- [ ] **Step 2: Validate JSON**

```bash
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"
```

Expected: no output (clean exit).

- [ ] **Step 3: Commit**

```bash
git add manifest.json
git commit -m "feat: register app-menu-recents-favorites in manifest"
```

---

### Task 4: Manual verification checklist

- [ ] In `chrome://extensions`, reload the Tulbelt extension.
- [ ] Open a `*.tulip.co` tab and reload it.
- [ ] Click the nav item that opens the app menu popper. Confirm Recents and Favorites appear after Functions, and both links navigate to the correct URLs.
- [ ] In the Tulbelt popup, toggle "App Menu: Recents & Favorites" **off**. Reopen the popper. Confirm Recents and Favorites are gone.
- [ ] Toggle back **on**. Confirm they return without a page reload.
