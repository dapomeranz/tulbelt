# Snap Widgets to 5px Grid — Design Spec

**Date:** 2026-05-29
**Feature ID:** `snap-to-grid`

## Problem

In the Tulip app editor you can drag and resize widgets to any sub-pixel
position. The drag is free-form, so widgets end up at coordinates like
`x: 694, y: 173, w: 531` that don't line up with each other, making alignment
across widgets sloppy.

## Goal

When a widget is dragged or resized in the app editor, snap the values that
changed during that interaction to the nearest multiple of 5 (design-space
units), on release. A move snaps X/Y; a resize snaps W/H (and X/Y too, if the
resize handle moved them). Fields the interaction didn't touch are left alone,
and manual edits to the number fields are never overridden.

Grid size is fixed at 5 — it is the premise of the feature, so there is no
configuration UI.

## Why this approach

The widget's position lives in Tulip's React state and is painted as
`transform: matrix(scale,0,0,scale, x, y)`. Writing directly to the DOM
transform is clobbered on the next React render and never updates Tulip's
stored position, so it would not persist and would fight the drag loop.

Instead we let Tulip own the entire drag, then write the snapped value back
through the editor's own context-pane number inputs, which already hold the
real design-space coordinates and which Tulip persists. This is the same
React-write-back pattern `action-editor-frequent.js` uses (native value setter
+ bubbling `input`/`change`).

## DOM Targets

The context pane (visible while a widget is selected/being dragged) exposes
four React-controlled number inputs, located by their stable `data-testid`s:

- `context-pane-tool-position-x` — X
- `context-pane-tool-position-y` — Y
- `context-pane-tool-size-w` — width
- `context-pane-tool-size-h` — height

(There is also a rotation input, `context-pane-tool-transform-rotate` — left
untouched.)

The editor canvas is `#cssCanvas`; dragged widgets are
`[data-testid="widget"]`.

## Scope

Active only on app version editor pages, matching
`collapse-tables-tile` / `hide-app-editor-chrome`:

- `/w/<ws>/apps/<id>/versions/<ver>`
- `/apps/<id>/versions/<ver>`

A `pathMatches()` guard returns early on any other page, and the feature
re-checks the path on SPA navigation.

## Implementation

### File: `toggles/snap-to-grid.js`

Standard IIFE content script. Follows the cross-realm-safe, multi-document
scanning shape of `context-menu-copy-cut.js` (so it works whether the canvas
and context pane are in the top document or an editor subframe).

**Constants:** `FEATURE_ID = 'snap-to-grid'`, `STORAGE_KEY = 'toggles'`,
`GRID = 5`, the four input `data-testid`s, and an `EPSILON` (e.g. `0.001`) for
"value changed" comparisons.

**State:**
- `enabled: boolean`
- `armed: boolean` — true between a canvas `pointerdown` and its `pointerup`
- `before: { x, y, w, h }` — input values captured at drag start
- `hookedDocs: Document[]` — documents we attached pointer listeners to

**`documentsToScan()`** — copied from `context-menu-copy-cut.js`: returns the
current document plus reachable ancestor/descendant same-origin frames.

**`pathMatches()`** — tests `location.pathname` against
`/(?:\/w\/[^/]+)?\/apps\/[^/]+\/versions\//`.

**`findInput(testid)`** — scans `documentsToScan()` for the first
`[data-testid="<testid>"]` element; returns it or `null`.

**`readPlacement()`** — returns `{ x, y, w, h }` parsed as floats from the four
inputs, with `null` for any input not found.

**`snapValue(v)`** — `Math.round(v / GRID) * GRID`.

**`setInputValue(input, value)`** — React-friendly write-back: use the native
`HTMLInputElement.prototype.value` setter
(`Object.getOwnPropertyDescriptor(...).set`, called against the input's own
window's prototype for cross-realm safety), then dispatch bubbling `input` and
`change` events.

**`onPointerDown(e)`** — if `enabled` and the event target is inside `#cssCanvas`
(or a `[data-testid="widget"]`), set `armed = true` and capture
`before = readPlacement()`. (Read at pointerdown, after Tulip's synchronous
selection, so `before` reflects the widget now being manipulated.)

**`onPointerUp()`** — if not `armed`, return. Set `armed = false`. On the next
animation frame (let Tulip commit final values), read `after = readPlacement()`.
For each of the four fields where both `before` and `after` are non-null and
`Math.abs(after - before) > EPSILON` (the field changed during this
interaction), compute `snapValue(after)` and, if it differs from `after`,
write it back via `setInputValue`. If `before`/`after` is null for a field,
skip it.

**`installHooks()`** — for each `documentsToScan()` doc not already in
`hookedDocs`, add capture-phase `pointerdown`/`pointerup` listeners and record
the doc.

**`removeHooks()`** — remove those listeners from every `hookedDocs` doc, clear
the array, reset `armed`/`before`.

**`syncFromStorage()`** — standard pattern: read storage, compare `next` vs
`enabled`, no-op if unchanged. On enable: `installHooks()` and start a low-rate
sweep (`setInterval` ~1.5s calling `installHooks()`, like
`context-menu-copy-cut.js`) so listeners reach frames that mount later. On
disable: clear the interval and `removeHooks()`.

`chrome.storage.onChanged` listener re-syncs; `syncFromStorage()` is called once
at the end.

### `features.js`

Append to the end of the `FEATURES` array (appending keeps DNR rule IDs stable):

```js
{
  id: 'snap-to-grid',
  name: 'Snap Widgets to 5px Grid',
  description:
    'In the app editor, snap a widget\u2019s position and size to the nearest multiple of 5 when you finish dragging or resizing it. Only the values changed by that interaction are snapped; manual edits to the X/Y/W/H fields are left alone.',
  defaultEnabled: false,
  major: false,
},
```

### `manifest.json`

Add `toggles/snap-to-grid.js` to the `all_frames: true` content-scripts block
(the same block as `context-menu-copy-cut.js`), since the canvas and/or context
pane may live in an editor subframe.

### `docs/toggles.md`

Add a minor-toggle entry describing the behavior and default (off).

## Revert Path

On disable, `removeHooks()` removes the pointer listeners and clears `armed`/
`before`. The feature never leaves any DOM mutation behind — input values are
only set transiently as part of a snap — so disabling cleanly stops all snapping
with no page reload. Positions already snapped while it was on remain where they
are, which is correct.

## Edge Cases & Notes

- **Click without movement:** `before === after` for all fields, so nothing is
  written (no-op).
- **Manual field entry:** not a canvas pointer drag, so `armed` is never set and
  the typed value is never overridden.
- **Stale selection at pointerdown:** `before` is read right after Tulip's
  synchronous selection on pointerdown; this is a best-effort baseline. Because
  we only snap fields that *changed*, a slightly stale baseline at worst snaps an
  extra field that genuinely moved — it never invents a change out of nothing.
- **Rotation:** never read or written.
- **Already on-grid:** `snapValue(after) === after`, so no write occurs.

## Success Criteria

1. Toggle on, on an app version editor page: drag a widget to an arbitrary
   spot; on release its X and Y become multiples of 5, width/height unchanged.
2. Resize a widget; on release its width/height (and X/Y if the handle moved
   them) become multiples of 5.
3. Typing a non-multiple value (e.g. 173) directly into the X field and leaving
   it is **not** overridden.
4. Toggle off: dragging/resizing no longer snaps; no reload needed.
5. Toggle on → off → on works without a page reload.
6. On non-editor pages, the feature does nothing.
7. No console errors. `node --check toggles/snap-to-grid.js` passes.
