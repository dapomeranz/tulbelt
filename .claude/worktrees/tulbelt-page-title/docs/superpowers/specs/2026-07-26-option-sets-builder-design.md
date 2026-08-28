# Option Sets Builder — Design

**Date:** 2026-07-26
**Toggle id:** `option-sets-builder`

## Summary

A new toggle that adds an "Option Sets" item to the Account Settings sidebar on
`*.tulip.co/account/*` pages. Clicking it shows a Tulbelt-owned page at the fake
URL `/account/option-sets`: Tulip's real header and settings sidebar stay
intact, but the main content pane is replaced with our own container. This
first version ships a placeholder shell (page title + empty content container);
the actual Option Sets builder UI is a follow-up.

Popup placement: visible to everyone, `defaultEnabled: true`, `major: true`.

## How the fake route works

The Tulip account area is a React SPA. React Router only reacts to navigations
it initiates (or `popstate`). So:

- **Inject a nav item** by cloning an existing (unselected) sidebar `<li>`,
  relabeled "Option Sets" with `data-testid="option-sets"`, inserted in
  alphabetical position (after "Network access", before "Player").
- **Intercept the click**: `preventDefault()`, then
  `history.pushState(null, "", "/account/option-sets")`. The URL bar changes;
  React never hears about it and keeps rendering the previous settings page.
- **Swap the body**: hide the content pane (all element siblings of the sidebar
  column), append our container in its place, and move the "selected" nav
  styling to our item.
- **Selected styling**: styled-components class hashes are build-specific, so
  they are never hardcoded. The selected `<li>` is detected as the minority
  className among sidebar items; that className is copied to our item and the
  demoted item gets the majority (unselected) className. Restored on
  deactivate.

## Lifecycle

- **Deactivate** (click on any real link while active): restore siblings,
  remove our container, restore nav classes, and `history.replaceState` back to
  the last real settings path so the router's belief and the URL agree again —
  then let the click proceed normally.
- **Back/forward**: `popstate` to a real URL deactivates (without touching the
  URL); `popstate` back to `/account/option-sets` re-activates.
- **Hard reload / direct link**: on load at `/account/option-sets`, wait for
  the sidebar to appear, then activate over whatever Tulip rendered (404 body
  or redirect target — if the SPA redirected away, push the fake URL back). If
  Tulip never renders the settings sidebar at all, the toggle no-ops.
- **Re-renders**: a MutationObserver re-injects the nav item and re-asserts the
  active state whenever React rebuilds the sidebar.
- **Toggle off while active**: deactivate, restore the underlying real page URL
  via `replaceState`, remove the nav item.

## Files

- `toggles/option-sets-builder.js` — new isolated-world content script
  (document_idle, same block as the other isolated toggles). No MAIN-world
  half; only DOM + `history` are touched.
- `manifest.json` — register the script.
- `features.js` — registry entry.

## The builder page (v2)

The placeholder body is replaced by the actual builder.

### Data model

One localStorage key on the tenant origin (per-instance scoping — a deliberate
choice over chrome.storage.local), `tulbelt-option-sets`:

```json
{ "version": 1,
  "sets": [ {
      "id": "os_…", "name": "Defect Types", "description": "",
      "dataType": "text" | "integer" | "number",
      "options": [ { "id": "op_…", "value": "Scratch", "description": "" } ],
      "createdAt": 0, "updatedAt": 0 } ] }
```

Option order is array order — that is the persisted sequence. Values persist
as strings; the data type governs the input widget and validation, never
silent coercion. Every change autosaves synchronously (no Save button).

### UI

Master–detail inside the page container:

- **Left panel:** "New option set" button plus the list of sets (name,
  data-type badge, option count); selected set highlighted.
- **Create form:** name (required) + data type select. Type is fixed once the
  set is created — changing type under existing values is a conversion mess
  not worth solving in v1.
- **Editor:** name input (red outline when empty), type badge, "Delete set"
  with inline Yes/No confirm (no browser popups), optional description
  textarea, then the options list: ▲/▼ reorder buttons, typed value input
  (`text` → text input; `integer` → number input step 1, validated
  `/^-?\d+$/`; `number` → number input, validated finite float), optional
  description input, ✕ remove. "+ Add option" appends and focuses the new row.
- Invalid/empty values stay editable with a red outline; what you typed is
  what's stored.

### Rendering

Full re-render on structural changes (select/create/delete/add/remove/move);
plain input events update state + save + targeted DOM tweaks only (left-list
name text, validation class), so focus is never lost mid-keystroke. Data
reloads from localStorage on each page activation so another tab's edits show
up after navigating away and back. localStorage read/write is wrapped in
try/catch; failures surface in a non-fatal banner.

## The use side: trigger editors (v3)

`toggles/option-sets-trigger.js` (isolated world, same feature toggle) lets
option sets fill in trigger static values. The invariant: **Tulip only ever
sees a normal Static value** — datasource = Static value, type = the set's
data type, value = the option's raw string. Option Set is a transient
authoring aid, not a stored representation.

- Every `select[data-testid="datasource-selector"]` is proxied: real select
  hidden, visually identical proxy (real options copied) shown, plus an
  "Option Set" entry inserted before Static value. Real picks forward to the
  hidden select via native value setter + bubbled change.
- Picking "Option Set": the real datasource is silently driven to Static
  value; the row's static type/value controls are hidden by a flow-scoped CSS
  rule (`:has()` keeps the datasource cell visible); a set picker appears,
  then an option picker (set descriptions/option descriptions as tooltips;
  options invalid for the set's type omitted).
- Picking an option: wait for React to render the type select → write the
  set's data type (matched by option label text) → wait for the value input →
  write the option's value (native setters + bubbled input/change). Then the
  pickers are removed and the native, now-populated controls reappear.
- **No reverse flow** (deliberate, to minimize edge cases): existing static
  values are never re-displayed as option sets, and the pickers vanish once
  the write-through completes.
- Sync: a MutationObserver re-scans on DOM changes; proxies whose real select
  was swept by a React re-render are removed and rebuilt; proxy values mirror
  React-driven changes when no flow is active. A row re-render mid-flow drops
  the transient flow state — the user just re-picks.
- If Tulip never renders the type select / value input (UI change), the flow
  aborts with a console warning and the row reverts to native display.

## Testing

Manual, like the rest of tulbelt: inject → click → fake URL → click away →
back/forward → hard reload on the fake URL → toggle off while on the page.
Builder: create sets of each type → add/edit/reorder/remove options →
validation outlines → delete confirm → reload page and confirm persistence →
check the `tulbelt-option-sets` key in DevTools.
Trigger side: open a trigger, pick Option Set in a "Select source of data"
dropdown → pick set → pick option → confirm the row shows Static value +
correct type + value and saves; pick a real source mid-flow to abort; verify
sets created on the settings page appear immediately in a trigger tab after
reopening the pickers.
