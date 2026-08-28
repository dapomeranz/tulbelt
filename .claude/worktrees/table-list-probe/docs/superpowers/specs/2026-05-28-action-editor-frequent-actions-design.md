# Frequent Actions On Top — design

## Problem

The trigger action-type picker (`<select data-testid="root-group-action-editor">`)
lists every action alphabetically. The handful of actions people reach for most
often — Data Manipulation, Table Records, Run Function, Run Connector Function —
are scattered through a long list, so picking a common action means scanning past
dozens of rarely-used ones.

## Goal

Pin those four frequent actions to the top of the dropdown, under a "Frequent"
group, with everything else under an "All actions" group. Each action appears
exactly once (the four are _moved_ to the top, not duplicated).

Success: opening the action picker shows the four frequent actions first under a
"Frequent" header, then the remaining actions in their original alphabetical
order under "All actions". Selecting any action behaves identically to selecting
it from the stock dropdown. Toggling the feature off restores the native dropdown
with no page reload.

## Constraints

- The `<select>` is React-controlled. React re-renders rebuild its `<option>`s.
  Moving React's own option nodes into injected `<optgroup>` wrappers makes React
  later call `removeChild` on a node that is no longer its direct child and throw.
  So we must not restructure React's nodes in place.
- Option `value` attributes are random per-instance IDs, so we match the four
  frequent actions by their **label text**, not their values.
- Must follow the project invariant: clean revert on disable, no page reload.

## Approach — proxy select (chosen)

Mirror the established `filters-builder.js` pattern: hide React's control and
render a sibling we fully own, forwarding changes back to React.

For each target select that contains at least one of the four frequent labels:

1. Build a sibling proxy `<select>`:
   - Copy the real select's `className`, `aria-label`, and inline `style` so it
     looks identical. Do **not** copy `id`/`data-testid` (no duplicates).
   - Mark it with `data-tulbelt-frequent-proxy` so our observer ignores it.
   - Structure:
     - the blank placeholder `<option>` first, kept top-level (so the
       empty/unselected state still works),
     - `<optgroup label="Frequent">` with the four pinned options cloned in the
       fixed order: Data Manipulation, Table Records, Run Function, Run Connector
       Function (only those that exist),
     - `<optgroup label="All actions">` with every remaining option in its
       original (alphabetical) order. Pinned options are not repeated here.
   - `proxy.value = real.value` to mirror current selection.
2. Hide the real select (`display:none` via a marker attribute) and insert the
   proxy immediately after it.
3. **Forwarding (proxy → React):** on the proxy's `change`, write the chosen
   value into the real select via the native `HTMLSelectElement` value setter and
   dispatch a bubbling `change` event, so React's `onChange` fires exactly as if
   the user used the original control.
4. **Mirroring (React → proxy):** on each reconcile, sync `proxy.value` from
   `real.value`; rebuild the proxy's options when the real select's option set
   changes (detected by comparing a label signature), so React re-renders that
   add/remove action types stay reflected.

### Target

Selects matching `select[data-testid$="action-editor"]` — covers
`root-group-action-editor` and any nested-group action editors uniformly.

### Robustness

- One `MutationObserver` on `document.body` (same as the other toggles) triggers
  reconcile when target selects appear or their options change. Mutations
  originating inside our own proxy (marked nodes) are ignored to avoid loops.
- A small injected stylesheet (under a `STYLE_ID`) holds just the hide rule;
  removed on disable.

### Revert (disable / toggle off)

Disconnect the observer, remove every proxy, unhide every real select, strip
marker attributes, and remove the style — full restore, no page reload.

## Registry / wiring

- New `FEATURES` entry appended to the end (so DNR rule IDs don't shift):
  - `id: 'action-editor-frequent'`
  - `name: 'Frequent Actions On Top'`
  - `defaultEnabled: true`, `major: false` (lands in "More"). No network `rule`.
- New content script `toggles/action-editor-frequent.js`, registered in
  `manifest.json`'s default `content_scripts` block (isolated world, top frame).
- New row in `docs/toggles.md` under "Minor toggles".

## Out of scope (YAGNI)

- User-configurable frequent list or per-user ordering. The four are hardcoded.
- Reordering within the "All actions" group.
- Any change to non-action-editor selects.
