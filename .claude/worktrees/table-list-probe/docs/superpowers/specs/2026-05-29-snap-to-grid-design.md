# Snap Widgets to 10px Grid — Design Spec

**Date:** 2026-05-29
**Feature ID:** `snap-to-grid`

> Note: built with a grid of 10 (changed from the original 5 during testing).
> The drag-detection and write-back sections below reflect the as-built
> behavior after debugging against a live editor.

## Problem

In the Tulip app editor you can drag and resize widgets to any sub-pixel
position. The drag is free-form, so widgets end up at coordinates like
`x: 694, y: 173, w: 531` that don't line up with each other, making alignment
across widgets sloppy.

## Goal

When a widget is dragged or resized in the app editor, snap the values that
changed during that interaction to the nearest multiple of 10 (design-space
units), on release. A move snaps X/Y; a resize snaps W/H (and X/Y too, if the
resize handle moved them). Fields the interaction didn't touch are left alone,
a plain click (no drag) snaps nothing, and manual edits to the number fields are
never overridden.

Grid size is fixed at 10 — it is the premise of the feature, so there is no
configuration UI.

## Why this approach

The widget's position lives in Tulip's React state and is painted as
`transform: matrix(scale,0,0,scale, x, y)`. Writing directly to the DOM
transform is clobbered on the next React render and never updates Tulip's
stored position, so it would not persist and would fight the drag loop.

Instead we let Tulip own the entire drag, then write the snapped value back
through the editor's own context-pane number inputs, which already hold the
real design-space coordinates and which Tulip persists.

Two things learned while debugging against the live editor shape the mechanism:

1. **Commit on blur/Enter.** These number inputs don't commit to the widget
   model on every `input`/`change`; they commit on blur or Enter. A bare
   native-setter write updates the field's display but not the widget (and a
   refresh reverts it). The write-back therefore focuses the input, sets the
   value via the native setter, fires `input`/`change`, then dispatches Enter
   and blur so Tulip's commit handler runs and persists the position.
2. **Late commit.** After a drag, Tulip writes the moved position into the pane
   inputs a few frames _after_ `pointerup`, not within one animation frame. So
   the post-drag value is read by polling the inputs over a short window rather
   than once.

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
`GRID = 10`, `DRAG_THRESHOLD_PX = 3`, the four input `data-testid`s, and an
`EPSILON` (e.g. `0.001`) for "value changed" comparisons.

**State:**

- `enabled: boolean`
- `armed: boolean` — true between a canvas `pointerdown` and its `pointerup`
- `moved: boolean` — set once pointer travel passes `DRAG_THRESHOLD_PX`
- `startX, startY: number` — pointer position at `pointerdown`
- `before: { x, y, w, h }` — input values captured on the first move
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

**`setInputValue(input, value)`** — mimic a user edit so Tulip commits: focus
the input, set the value via the native `HTMLInputElement.prototype.value`
setter (`Object.getOwnPropertyDescriptor(...).set`, taken from the input's own
window prototype for cross-realm safety), dispatch bubbling `input`/`change`,
then dispatch Enter (`keydown`/`keyup`) and blur (`input.blur()` + `focusout`)
so the commit-on-blur/Enter handler persists it.

**`onPointerDown(e)`** — if `enabled`, `pathMatches()`, primary button, and the
target is inside `#cssCanvas` / a `[data-testid="widget"]`: set `armed = true`,
`moved = false`, record `startX/startY` from the event, and clear `before`
(captured later, on the first move).

**`onPointerMove(e)`** — if not `armed`, return. On the first move capture
`before = readPlacement()` — by now Tulip has selected the widget and the pane
shows its pre-drag values (which stay static during the drag), so this is a
clean baseline that reflects the widget actually being manipulated (not a stale
prior selection). Once pointer travel from `startX/startY` exceeds
`DRAG_THRESHOLD_PX` (3px), set `moved = true`.

**`onPointerUp()`** — if not `armed`, return. Set `armed = false`; capture
`start = before` and `wasDrag = moved`; reset both. If `!wasDrag` (a click) or
`!start`, return without snapping. Otherwise poll `readPlacement()` over a short
window (`SETTLE_DELAYS_MS = [16,50,100,200,350,550,800]` ms) until it differs
from `start` (Tulip commits the moved value a few frames late); on the first
differing sample, snap each of the four fields where
`Math.abs(after - before) > EPSILON` and `snapValue(after) !== after`, via
`setInputValue`. If nothing changes within the window, do nothing.

**`installHooks()`** — for each `documentsToScan()` doc not already in
`hookedDocs`, add capture-phase `pointerdown`/`pointermove`/`pointerup`
listeners and record the doc.

**`removeHooks()`** — remove those listeners from every `hookedDocs` doc, clear
the array, reset `armed`/`moved`/`before`.

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
  name: 'Snap Widgets to 10px Grid',
  description:
    'In the app editor, snap a widget\u2019s position and size to the nearest multiple of 10 when you finish dragging or resizing it. Only the values changed by that interaction are snapped; clicking a widget or manually editing the X/Y/W/H fields is left alone.',
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

On disable, `removeHooks()` removes the pointer listeners and clears
`armed`/`moved`/`before`. The feature never leaves any DOM mutation behind —
input values are only set transiently as part of a snap — so disabling cleanly
stops all snapping with no page reload. Positions already snapped while it was on
remain where they are, which is correct.

## Edge Cases & Notes

- **Click without movement:** the pointer never passes `DRAG_THRESHOLD_PX`, so
  `wasDrag` is false and nothing is snapped — selecting a widget leaves it
  exactly as-is. (This is the behavior that gates the otherwise-misleading
  "selection switched the pane to a different widget" case.)
- **Manual field entry:** not a canvas pointer drag, so `armed`/`moved` are
  never set and the typed value is never overridden.
- **Baseline timing:** `before` is captured on the first `pointermove` (after
  Tulip's selection), and the pane stays static during the drag, so the baseline
  reflects the widget actually being manipulated.
- **Rotation:** never read or written.
- **Already on-grid / no change:** `snapValue(after) === after` (or no field
  changed), so no write occurs.

## Success Criteria

1. Toggle on, on an app version editor page: drag a widget to an arbitrary
   spot; on release its X and Y become multiples of 10, width/height unchanged,
   and the widget actually moves and survives a page refresh.
2. Resize a widget; on release its width/height (and X/Y if the handle moved
   them) become multiples of 10.
3. Clicking a widget without dragging snaps nothing and leaves its values as-is.
4. Typing a non-multiple value directly into the X field and leaving it is
   **not** overridden.
5. Toggle off: dragging/resizing no longer snaps; no reload needed.
6. Toggle on → off → on works without a page reload.
7. On non-editor pages, the feature does nothing.
8. No console errors. `node --check toggles/snap-to-grid.js` passes.
