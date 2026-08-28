# App Menu Recents & Favorites — Design Spec

**Date:** 2026-05-28  
**Feature ID:** `app-menu-recents-favorites`

## Problem

The navigation popper (triggered from the top nav bar) shows Apps, Tables, Connectors, and Functions. The Apps link goes directly to `/apps/folders?view=recents`, but there is no quick way to jump to Recents or Favorites from that dropdown.

## Goal

Inject "Recents" and "Favorites" as two additional `<li>` items at the bottom of this popper's `<ul>`, after Functions. Recents links to `/apps/folders?view=recents`; Favorites links to `/apps/folders?view=favorites`. The toggle must cleanly remove both items when disabled.

## DOM Target

The popper is identified by:

- `[data-testid="popper"]` on the outer wrapper
- A `<ul>` inside it that contains an `<a>` whose `href` includes `/apps/folders` (signature check to avoid false matches on other poppers on the page)

Final menu order: Apps → Tables → Connectors → Functions → **Recents** → **Favorites**

## Implementation

### File: `toggles/app-menu-recents-favorites.js`

Standard IIFE content script. Pattern follows `reorder-row-buttons.js` and `context-menu-copy-cut.js`.

**State:**

- `enabled: boolean` — toggled from storage
- `observer: MutationObserver | null` — watches `document.body` for the popper appearing/re-mounting

**`findTargetUl()`** — queries all `[data-testid="popper"] ul` elements, returns the first whose inner `<a>` href contains `/apps/folders`. Returns `null` if the popper is not present.

**`isAlreadyInjected(ul)`** — returns true if `ul` contains a `[data-tulbelt-amrf]` child.

**`injectItems(ul)`** — clones the last `<li>` in `ul` (for shape/class fidelity), overwrites `href` and link text for Recents then Favorites, sets `data-tulbelt-amrf` on each, appends both to `ul`.

**`removeInjections()`** — `document.querySelectorAll('[data-tulbelt-amrf]').forEach(el => el.remove())`.

**`applyToPresent()`** — calls `findTargetUl()`, skips if null or already injected, otherwise calls `injectItems()`.

**`onMutation(mutations)`** — for each added node, if it is or contains `[data-testid="popper"]`, calls `applyToPresent()`.

**`startObserver()`** — creates `MutationObserver(onMutation)`, observes `document.body` with `{ childList: true, subtree: true }`.

**`stopObserver()`** — disconnects and nulls the observer.

**`syncFromStorage()`** — standard pattern: reads storage, compares `next` vs `enabled`, on enable: `applyToPresent()` + `startObserver()`; on disable: `stopObserver()` + `removeInjections()`.

### `features.js`

Add entry (append to `FEATURES` array):

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

### `manifest.json`

Add `toggles/app-menu-recents-favorites.js` to the default `content_scripts` block (the `run_at: "document_idle"` block without `all_frames` or `world: "MAIN"`).

## Revert Path

On disable, `removeInjections()` removes every `[data-tulbelt-amrf]` element. The original React-owned `<li>` nodes are never touched. No page reload needed.

## Success Criteria

1. With toggle on: opening the nav popper shows Recents and Favorites after Functions; both links navigate to the correct URLs.
2. With toggle off: the extra items are gone; the popper shows only the original four items.
3. Toggle on → off → on works without a page reload.
4. No console errors.
